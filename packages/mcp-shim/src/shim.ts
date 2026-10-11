import { PolicyEvaluator, type CloudPusher } from '@jamjet/cloud'
import { loadPolicy, AuditWriter, ApprovalQueue } from '@jamjet/cloud/node'
import { JsonRpcStream } from './jsonrpc.js'
import { Supervisor } from './supervisor.js'
import {
  buildCloudPusher,
  pushAuditEvent,
  resolveArgsRedaction,
  type ArgsRedactionMode,
} from './cloud-push.js'
import {
  loadTrustBaseline,
  loadThreatConfig,
  buildMcpSecurityReceipt,
  appendReceipt,
} from '@jamjet/mcp-threat'
import { ShimCore } from './core.js'
import { loadShimConfig, resolvePolicyPath } from './shim-config.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ShimOptions {
  policyPath?: string
  serverName: string
  command: string
  args: string[]
  /** Override the tool pin file (else policy mcp.pinning.file, JAMJET_TOOL_PINS, default). */
  pinsPath?: string
  /** Inject a CloudPusher; undefined falls back to env-driven detection. */
  cloudPusher?: CloudPusher | null
  /** R9 args redaction for events leaving the host. Defaults to env or 'full'. */
  argsRedaction?: ArgsRedactionMode
}

export async function runShim(options: ShimOptions): Promise<number | null> {
  const policy = loadPolicy(options.policyPath)
  const evaluator = new PolicyEvaluator()
  for (const r of policy.rules) evaluator.add(r.action, r.match)

  // Read the mcp:/threat: blocks from the same file loadPolicy resolved, so an
  // auto-discovered policy is not treated as "no settings".
  const resolvedPolicyPath = resolvePolicyPath(options.policyPath)
  const config = loadShimConfig(resolvedPolicyPath)
  if (options.pinsPath) config.pinning.file = options.pinsPath

  const auditDir = policy.audit?.destination?.replace(/^~/, homedir()) ?? join(homedir(), '.jamjet', 'audit')
  const pendingDir = join(homedir(), '.jamjet', 'pending')
  const audit = new AuditWriter({ destination: auditDir, adapter: 'mcp-shim' })
  const approvals = new ApprovalQueue({ pendingDir, defaultTimeoutMs: 300_000 })

  const pusher = options.cloudPusher === undefined ? buildCloudPusher() : options.cloudPusher
  const redactionMode = resolveArgsRedaction(options.argsRedaction)
  const receiptsPath = join(auditDir, 'mcp-receipts.jsonl')

  const supervisor = new Supervisor({ command: options.command, args: options.args })
  const core = new ShimCore({
    serverName: options.serverName,
    evaluator,
    config,
    threatBaseline: loadTrustBaseline(),
    threatConfig: loadThreatConfig(resolvedPolicyPath),
    toClient: (m) => process.stdout.write(JsonRpcStream.encode(m as never)),
    toServer: (m) => supervisor.writeStdin(JsonRpcStream.encode(m as never)),
    log: (line) => process.stderr.write(line),
    audit: (e) => {
      audit.write({ ...e, host: 'claude-desktop' })
      if (pusher) {
        pushAuditEvent({
          pusher, run_id: e.run_id, serverName: e.server, tool: e.tool, args: e.args,
          decision: e.decision, rule: e.rule, rule_kind: e.rule_kind, executed: e.executed,
          trace_id: e.trace_id, redactionMode,
        })
      }
    },
    receipt: (finding, decision, action) =>
      appendReceipt(receiptsPath, buildMcpSecurityReceipt(finding, decision, action, new Date().toISOString())),
    approvals: {
      enqueue: (req) => approvals.enqueue({ ...req, adapter: 'mcp-shim' }),
      wait: (runId) => approvals.wait(runId),
    },
  })

  const upstream = new JsonRpcStream()   // from client (stdin)
  const downstream = new JsonRpcStream() // from real server (subprocess stdout)
  upstream.on('message', (msg) => {
    core.onClientMessage(msg).catch((err) => process.stderr.write(`JamJet: error handling client message: ${(err as Error).message}\n`))
  })
  upstream.on('error', () => {
    process.stdout.write(JsonRpcStream.encode({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } as never))
  })
  downstream.on('message', (msg) => core.onServerMessage(msg))
  downstream.on('error', (err) => process.stderr.write(`JamJet: dropped unparseable server output: ${err.message}\n`))

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
