import { PolicyEvaluator, type CloudPusher } from '@jamjet/cloud'
import { loadPolicy, AuditWriter, ApprovalQueue } from '@jamjet/cloud/node'
import { JsonRpcStream, type JsonRpcRequest } from './jsonrpc.js'
import { Supervisor } from './supervisor.js'
import { interceptToolsCall, blockResponse } from './tools-call.js'
import {
  buildCloudPusher,
  pushAuditEvent,
  resolveArgsRedaction,
  traceIdFromMcpRequest,
  type ArgsRedactionMode,
} from './cloud-push.js'
import {
  loadTrustBaseline,
  loadThreatConfig,
  evaluateToolsList,
  evaluateCall,
  buildMcpSecurityReceipt,
  appendReceipt,
  strictest,
  type Decision,
  type ThreatFinding,
} from '@jamjet/mcp-threat'
import { isToolsListResult, extractToolsFromListResponse } from './tools-list.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ShimOptions {
  policyPath?: string
  serverName: string
  command: string
  args: string[]
  /** Inject a CloudPusher; undefined falls back to env-driven detection. */
  cloudPusher?: CloudPusher | null
  /** R9 args redaction for events leaving the host. Defaults to env or 'full'. */
  argsRedaction?: ArgsRedactionMode
}

export async function runShim(options: ShimOptions): Promise<number | null> {
  const policy = loadPolicy(options.policyPath)
  const evaluator = new PolicyEvaluator()
  for (const r of policy.rules) evaluator.add(r.action, r.match)

  const auditDir = policy.audit?.destination?.replace(/^~/, homedir()) ?? join(homedir(), '.jamjet', 'audit')
  const pendingDir = join(homedir(), '.jamjet', 'pending')
  const audit = new AuditWriter({ destination: auditDir, adapter: 'mcp-shim' })
  const approvals = new ApprovalQueue({ pendingDir, defaultTimeoutMs: 300_000 })

  const pusher = options.cloudPusher === undefined ? buildCloudPusher() : options.cloudPusher
  const redactionMode = resolveArgsRedaction(options.argsRedaction)

  const baseline = loadTrustBaseline()
  const threatConfig = loadThreatConfig(options.policyPath)
  const receiptsPath = join(auditDir, 'mcp-receipts.jsonl')
  let serverUnverified = false
  const flagged = new Map<string, ThreatFinding>()

  const emitReceipt = (finding: ThreatFinding, decision: Decision, action: 'tools/call' | 'tools/list') => {
    appendReceipt(receiptsPath, buildMcpSecurityReceipt(finding, decision, action, new Date().toISOString()))
  }

  const upstream = new JsonRpcStream()   // from client (stdin)
  const downstream = new JsonRpcStream() // from real server (subprocess stdout)
  const supervisor = new Supervisor({ command: options.command, args: options.args })

  upstream.on('message', async (msg) => {
    if ('method' in msg && msg.method === 'tools/call') {
      const intercept = interceptToolsCall(msg as JsonRpcRequest, evaluator)
      if (!intercept) {
        supervisor.writeStdin(JsonRpcStream.encode(msg))
        return
      }
      const threat = evaluateCall({
        server: options.serverName,
        tool: intercept.tool,
        args: intercept.args,
        flagged,
        serverUnverified,
        config: threatConfig,
      })
      const combinedDecision = strictest(intercept.decision as Decision, threat.decision.decision)
      const threatDrove = threat.decision.finding !== null &&
        threat.decision.decision === combinedDecision &&
        intercept.decision !== combinedDecision
      if (threat.decision.finding && combinedDecision !== 'ALLOWED') {
        emitReceipt(threat.decision.finding, combinedDecision, 'tools/call')
      }
      const ruleLabel = threatDrove ? `threat:${threat.decision.finding!.risk_class}` : intercept.rule
      const ruleKind = threatDrove ? null : intercept.rule_kind
      const run_id = `run_${Date.now().toString(36)}`
      const executed = combinedDecision === 'ALLOWED' || combinedDecision === 'AUDIT'
      const trace_id = traceIdFromMcpRequest((msg as JsonRpcRequest).params)
      audit.write({
        run_id, trace_id, host: 'claude-desktop',
        server: options.serverName, tool: intercept.tool, args: intercept.args,
        decision: combinedDecision, rule: ruleLabel, rule_kind: ruleKind, executed,
      })
      if (pusher) {
        pushAuditEvent({
          pusher, run_id, serverName: options.serverName, tool: intercept.tool, args: intercept.args,
          decision: combinedDecision, rule: ruleLabel, rule_kind: ruleKind, executed, trace_id, redactionMode,
        })
      }
      if (combinedDecision === 'BLOCKED') {
        process.stdout.write(JsonRpcStream.encode(blockResponse((msg as JsonRpcRequest).id, ruleLabel)))
        return
      }
      if (combinedDecision === 'WAITING_FOR_APPROVAL') {
        const runId = approvals.enqueue({ tool: intercept.tool, args: intercept.args, adapter: 'mcp-shim' })
        process.stderr.write(`JamJet: ${intercept.tool} waiting approval — run \`jamjet approve ${runId}\`\n`)
        const result = await approvals.wait(runId)
        if (result.status === 'approved') {
          supervisor.writeStdin(JsonRpcStream.encode(msg))
        } else {
          process.stdout.write(JsonRpcStream.encode(blockResponse((msg as JsonRpcRequest).id, ruleLabel)))
        }
        return
      }
      supervisor.writeStdin(JsonRpcStream.encode(msg))
    } else {
      supervisor.writeStdin(JsonRpcStream.encode(msg))
    }
  })

  downstream.on('message', (msg) => {
    if (isToolsListResult(msg)) {
      try {
        const tools = extractToolsFromListResponse(msg)
        const evalResult = evaluateToolsList(options.serverName, tools, baseline, threatConfig)
        serverUnverified = evalResult.serverUnverified
        flagged.clear()
        for (const [name, f] of evalResult.flagged) flagged.set(name, f)
        if (evalResult.decision.finding) {
          emitReceipt(evalResult.decision.finding, evalResult.decision.decision, 'tools/list')
          process.stderr.write(
            `JamJet threat: ${evalResult.decision.finding.risk_class} on ${options.serverName} ` +
            `(${evalResult.decision.decision})\n`,
          )
        }
      } catch (err) {
        process.stderr.write(`JamJet threat: tools/list evaluation error (forwarding unscanned): ${(err as Error).message}\n`)
      }
    }
    process.stdout.write(JsonRpcStream.encode(msg))
  })

  process.stdin.on('data', (b: Buffer) => upstream.feed(b))
  supervisor.onStdout((b: Buffer) => downstream.feed(b))
  supervisor.onStderr((b: Buffer) => process.stderr.write(b))

  supervisor.start()

  return new Promise<number | null>((resolve) => {
    supervisor.onExit((code) => resolve(code))
    process.on('SIGTERM', () => supervisor.kill('SIGTERM'))
    process.on('SIGINT', () => supervisor.kill('SIGINT'))
  })
}
