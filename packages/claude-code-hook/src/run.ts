// One hook invocation, from argv + stdin to an exit code and output.
//
// Claude Code reads a PreToolUse hook's result like this:
//   exit 2           block the call; stderr goes to the model
//   exit 0           go ahead, unless stdout carries a JSON decision
//   any other code   non-blocking error: the tool runs anyway
// So anything that is not a clean allow or ask returns exit 2.

import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy, AuditWriter } from '@jamjet/cloud/node'
import { join } from 'node:path'
import { evaluateHookInput, type HookInput, type HookResult } from './hook.js'
import { expandHome, parseArgs, resolvePolicyPath } from './options.js'
import {
  buildCloudPusher,
  pushAuditEvent,
  resolveArgsRedaction,
  traceIdFromEnv,
} from './cloud-push.js'

export interface RunOptions {
  argv: string[]
  env: Record<string, string | undefined>
  stdin: string
  home: string
}

export interface HookOutcome {
  exitCode: 0 | 2
  stdout: string
  stderr: string
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Exit 2 with a short reason. Used for every error path. */
export function refuse(reason: string): HookOutcome {
  return { exitCode: 2, stdout: '', stderr: `jamjet-hook: blocking tool call: ${reason}\n` }
}

export function runHook(opts: RunOptions): HookOutcome {
  try {
    return run(opts)
  } catch (err) {
    return refuse(errorMessage(err))
  }
}

type Policy = ReturnType<typeof loadPolicy>

function run(opts: RunOptions): HookOutcome {
  const args = parseArgs(opts.argv)
  const { path: policyPath } = resolvePolicyPath(args.policy, opts.env, opts.home)

  let policy: Policy
  try {
    policy = loadPolicy(policyPath)
  } catch (err) {
    throw new Error(`policy ${policyPath}: ${errorMessage(err)}`)
  }
  const auditDir = resolveAuditDir(policy, opts.home)

  const evaluator = new PolicyEvaluator()
  for (const rule of policy.rules) evaluator.add(rule.action, rule.match)

  const input = parseInput(opts.stdin)
  const result = evaluateHookInput(input, evaluator)

  // The decision is fixed here, before any side effect. The audit step below
  // can only make it stricter, never looser.
  let outcome = outcomeFor(result, input.permission_mode)

  try {
    recordAudit(auditDir, input, result)
  } catch (err) {
    const why = `audit write to ${auditDir} failed: ${errorMessage(err)}`
    if (outcome.exitCode === 2) {
      outcome = { ...outcome, stderr: outcome.stderr + `jamjet-hook: ${why}\n` }
    } else if (args.allowAuditFailure) {
      outcome = { ...outcome, stderr: outcome.stderr + `jamjet-hook: warning: ${why} (--allow-audit-failure is set)\n` }
    } else {
      outcome = refuse(`${why}. Fix the audit destination, or pass --allow-audit-failure to run tools without an audit record`)
    }
  }
  return outcome
}

// Permission modes in which a hook's "ask" puts the call in front of a person
// (or, in dontAsk, denies it). In bypassPermissions the prompt is skipped and
// in auto mode a classifier answers it, so an approval rule would let the call
// run with nobody asked. Those modes, unknown modes, and a missing
// permission_mode get a block instead.
const MODES_THAT_ASK_A_PERSON = new Set(['default', 'acceptEdits', 'plan', 'dontAsk'])

function outcomeFor(result: HookResult, permissionMode: string | undefined): HookOutcome {
  switch (result.decision) {
    case 'ALLOWED':
    case 'AUDIT':
      return { exitCode: 0, stdout: '', stderr: '' }
    case 'BLOCKED':
      return { exitCode: 2, stdout: '', stderr: `JamJet policy: BLOCKED (rule: ${result.rule})\n` }
    case 'WAITING_FOR_APPROVAL': {
      if (permissionMode === undefined || !MODES_THAT_ASK_A_PERSON.has(permissionMode)) {
        const mode = permissionMode === undefined ? 'no permission_mode' : `permission_mode ${JSON.stringify(permissionMode)}`
        return {
          exitCode: 2,
          stdout: '',
          stderr: `JamJet policy: BLOCKED (rule: ${result.rule}): approval required, and ${mode} would not ask a person\n`,
        }
      }
      const decision = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `JamJet policy: approval required (rule: ${result.rule})`,
        },
      }
      return { exitCode: 0, stdout: JSON.stringify(decision) + '\n', stderr: '' }
    }
    default: {
      const unknown: never = result.decision
      return refuse(`unknown decision: ${String(unknown)}`)
    }
  }
}

function resolveAuditDir(policy: Policy, home: string): string {
  const destination: unknown = policy.audit?.destination
  if (destination === undefined || destination === null) return join(home, '.jamjet', 'audit')
  if (typeof destination !== 'string' || destination === '') {
    throw new Error('policy audit.destination must be a non-empty string')
  }
  return expandHome(destination, home)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseInput(raw: string): HookInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('stdin is not valid JSON')
  }
  if (!isObject(parsed)) throw new Error('stdin must be a JSON object')

  const event = parsed.hook_event_name
  if (event !== undefined && event !== 'PreToolUse') {
    throw new Error(`jamjet-hook only handles PreToolUse, got ${JSON.stringify(event)}`)
  }
  const toolName = parsed.tool_name
  if (typeof toolName !== 'string' || toolName === '') throw new Error('stdin has no tool_name')
  const toolInput = parsed.tool_input ?? {}
  if (!isObject(toolInput)) throw new Error('tool_input must be a JSON object')

  const input: HookInput = { tool_name: toolName, tool_input: toolInput }
  if (typeof parsed.session_id === 'string') input.session_id = parsed.session_id
  if (typeof parsed.permission_mode === 'string') input.permission_mode = parsed.permission_mode
  return input
}

function recordAudit(auditDir: string, input: HookInput, result: HookResult): void {
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

  // Path B direct push to Cloud. The push itself is fire-and-forget and never
  // changes the decision; a setup error here counts as an audit failure.
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
}
