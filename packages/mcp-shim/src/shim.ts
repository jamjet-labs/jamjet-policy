import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy, AuditWriter, ApprovalQueue } from '@jamjet/cloud/node'
import { JsonRpcStream, type JsonRpcRequest } from './jsonrpc.js'
import { Supervisor } from './supervisor.js'
import { interceptToolsCall, blockResponse } from './tools-call.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ShimOptions {
  policyPath?: string
  serverName: string
  command: string
  args: string[]
}

export async function runShim(options: ShimOptions): Promise<number | null> {
  const policy = loadPolicy(options.policyPath)
  const evaluator = new PolicyEvaluator()
  for (const r of policy.rules) evaluator.add(r.action, r.match)

  const auditDir = policy.audit?.destination?.replace(/^~/, homedir()) ?? join(homedir(), '.jamjet', 'audit')
  const pendingDir = join(homedir(), '.jamjet', 'pending')
  const audit = new AuditWriter({ destination: auditDir, adapter: 'mcp-shim' })
  const approvals = new ApprovalQueue({ pendingDir, defaultTimeoutMs: 300_000 })

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
      audit.write({
        run_id: `run_${Date.now().toString(36)}`,
        host: 'claude-desktop',  // best guess; future: detect via initialize params
        server: options.serverName,
        tool: intercept.tool,
        args: intercept.args,
        decision: intercept.decision,
        rule: intercept.rule,
        rule_kind: intercept.rule_kind,
        executed: intercept.decision === 'ALLOWED' || intercept.decision === 'AUDIT',
      })
      if (intercept.decision === 'BLOCKED') {
        process.stdout.write(JsonRpcStream.encode(blockResponse((msg as JsonRpcRequest).id, intercept.rule)))
        return
      }
      if (intercept.decision === 'WAITING_FOR_APPROVAL') {
        const runId = approvals.enqueue({
          tool: intercept.tool, args: intercept.args, adapter: 'mcp-shim',
        })
        process.stderr.write(`JamJet: ${intercept.tool} waiting approval — run \`jamjet approve ${runId}\`\n`)
        const result = await approvals.wait(runId)
        if (result.status === 'approved') {
          supervisor.writeStdin(JsonRpcStream.encode(msg))
        } else {
          process.stdout.write(JsonRpcStream.encode(blockResponse((msg as JsonRpcRequest).id, intercept.rule)))
        }
        return
      }
      // ALLOWED or AUDIT: forward
      supervisor.writeStdin(JsonRpcStream.encode(msg))
    } else {
      supervisor.writeStdin(JsonRpcStream.encode(msg))
    }
  })

  downstream.on('message', (msg) => {
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
