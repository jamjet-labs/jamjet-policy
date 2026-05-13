#!/usr/bin/env node
import { evaluateHookInput, type HookInput } from './hook.js'
import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy, AuditWriter } from '@jamjet/cloud/node'
import {
  buildCloudPusher,
  pushAuditEvent,
  resolveArgsRedaction,
  traceIdFromEnv,
} from './cloud-push.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const policyFlag = args.indexOf('--policy')
  const policyPath = policyFlag >= 0 ? args[policyFlag + 1] : undefined

  const policy = loadPolicy(policyPath)
  const evaluator = new PolicyEvaluator()
  for (const rule of policy.rules) {
    evaluator.add(rule.action, rule.match)
  }

  // Read stdin
  const stdinChunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    stdinChunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(stdinChunks).toString('utf-8').trim()

  let input: HookInput
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    process.stderr.write('jamjet-hook: invalid JSON on stdin\n')
    process.exit(1)
  }

  const result = evaluateHookInput(input, evaluator)

  // Write audit event
  const auditDir = policy.audit?.destination?.replace(/^~/, homedir()) ?? join(homedir(), '.jamjet', 'audit')
  const writer = new AuditWriter({ destination: auditDir, adapter: 'claude-code-hook' })
  const run_id = `run_${Date.now().toString(36)}`
  const executed = result.decision === 'ALLOWED' || result.decision === 'AUDIT'
  const trace_id = traceIdFromEnv()
  writer.write({
    run_id,
    trace_id,
    host: 'claude-code',
    server: result.server,
    tool: result.effective_tool,
    args: input.tool_input,
    decision: result.decision,
    rule: result.rule,
    rule_kind: result.rule_kind,
    executed,
  })

  // Path B direct-push (when JAMJET_CLOUD_TOKEN + env says direct).
  const pusher = buildCloudPusher()
  if (pusher) {
    pushAuditEvent({
      pusher,
      run_id,
      tool: result.effective_tool,
      args: input.tool_input,
      decision: result.decision,
      rule: result.rule,
      rule_kind: result.rule_kind,
      executed,
      server: result.server,
      trace_id,
      redactionMode: resolveArgsRedaction(),
    })
  }

  // Stderr feedback
  if (result.decision === 'BLOCKED') {
    process.stderr.write(`JamJet policy: BLOCKED (rule: ${result.rule})\n`)
  } else if (result.decision === 'WAITING_FOR_APPROVAL') {
    process.stderr.write(`JamJet policy: WAITING_FOR_APPROVAL (rule: ${result.rule}) — approval flow not yet implemented in v0.1; treating as block\n`)
  }

  process.exit(result.exit_code)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`jamjet-hook: ${msg}\n`)
  process.exit(1)
})
