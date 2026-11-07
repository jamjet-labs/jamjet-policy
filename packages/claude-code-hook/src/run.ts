// One hook invocation, from argv + stdin to an exit code and output.
//
// Claude Code reads a PreToolUse hook's result like this:
//   exit 2           block the call; stderr goes to the model
//   exit 0           go ahead, unless stdout carries a JSON decision
//   any other code   non-blocking error: the tool runs anyway
// So anything that is not a clean allow or ask returns exit 2.

import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT_DEADLINE_MS, writeAuditInChild } from './audit.js'
import { evaluateHookInput, type HookInput, type HookResult } from './hook.js'
import { expandHome, parseArgs, resolvePolicyPath } from './options.js'
import { loadHookPolicy, TOOL_NAME, type HookPolicy } from './policy.js'
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

/** What the hook tells Claude Code, recorded in the audit line. */
type HookDecision = 'allow' | 'ask' | 'block'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Exit 2 with a short reason. Used for every error path. */
export function refuse(reason: string): HookOutcome {
  return { exitCode: 2, stdout: '', stderr: `jamjet-hook: blocking tool call: ${reason}\n` }
}

export async function runHook(opts: RunOptions): Promise<HookOutcome> {
  try {
    return await run(opts)
  } catch (err) {
    return refuse(errorMessage(err))
  }
}

async function run(opts: RunOptions): Promise<HookOutcome> {
  const args = parseArgs(opts.argv)
  const { path: policyPath } = resolvePolicyPath(args.policy, opts.env, opts.home)

  let policy: HookPolicy
  try {
    policy = loadHookPolicy(policyPath)
  } catch (err) {
    throw new Error(`policy ${policyPath}: ${errorMessage(err)}`)
  }
  const auditDir = resolveAuditDir(policy, opts.home)

  const input = parseInput(opts.stdin)
  const result = evaluateHookInput(input, policy.rules)

  // The decision is fixed here, before any side effect. The audit step below
  // can only make it stricter, never looser, and is bounded by a deadline.
  const { outcome: decided, hookDecision } = outcomeFor(result, input.permission_mode)
  let outcome = decided

  try {
    await recordAudit(auditDir, policy, input, result, hookDecision)
  } catch (err) {
    const why = `audit write under ${auditDir} failed: ${errorMessage(err)}`
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

// Permission modes in which a hook's "ask" reaches Claude Code's permission
// prompt (in dontAsk, a denial). The hooks docs say auto mode still shows
// hook prompts. They say nothing either way for a hook's "ask" in plan or
// bypassPermissions mode, so those get a block, as do unknown modes and a
// missing permission_mode.
const MODES_THAT_ASK_A_PERSON = new Set(['default', 'acceptEdits', 'auto', 'dontAsk'])

function outcomeFor(
  result: HookResult,
  permissionMode: string | undefined,
): { outcome: HookOutcome; hookDecision: HookDecision } {
  switch (result.decision) {
    case 'ALLOWED':
    case 'AUDIT':
      return { outcome: { exitCode: 0, stdout: '', stderr: '' }, hookDecision: 'allow' }
    case 'BLOCKED':
      return {
        outcome: { exitCode: 2, stdout: '', stderr: `JamJet policy: BLOCKED (rule: ${result.rule})\n` },
        hookDecision: 'block',
      }
    case 'WAITING_FOR_APPROVAL': {
      if (permissionMode === undefined || !MODES_THAT_ASK_A_PERSON.has(permissionMode)) {
        const mode = permissionMode === undefined ? 'no permission_mode' : `permission_mode ${JSON.stringify(permissionMode)}`
        return {
          outcome: {
            exitCode: 2,
            stdout: '',
            stderr: `JamJet policy: BLOCKED (rule: ${result.rule}): approval required, and ${mode} would not ask a person\n`,
          },
          hookDecision: 'block',
        }
      }
      const decision = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `JamJet policy: approval required (rule: ${result.rule})`,
        },
      }
      return { outcome: { exitCode: 0, stdout: JSON.stringify(decision) + '\n', stderr: '' }, hookDecision: 'ask' }
    }
    default: {
      const unknown: never = result.decision
      return { outcome: refuse(`unknown decision: ${String(unknown)}`), hookDecision: 'block' }
    }
  }
}

function resolveAuditDir(policy: HookPolicy, home: string): string {
  const destination = policy.audit.destination
  const dir = destination === undefined ? join(home, '.jamjet', 'audit') : expandHome(destination, home)
  if (!isAbsolute(dir)) {
    throw new Error(
      `audit.destination ${JSON.stringify(destination)} is a relative path, which would resolve against the project directory; use an absolute path`,
    )
  }
  return dir
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
  // Claude Code only calls tools whose names the Claude API accepts. Anything
  // else did not come from Claude Code.
  if (!TOOL_NAME.test(toolName)) {
    throw new Error(`tool_name ${JSON.stringify(toolName.slice(0, 200))} is not a Claude Code tool name`)
  }
  const toolInput = parsed.tool_input ?? {}
  if (!isObject(toolInput)) throw new Error('tool_input must be a JSON object')

  const input: HookInput = { tool_name: toolName, tool_input: toolInput }
  if (typeof parsed.session_id === 'string') input.session_id = parsed.session_id
  if (typeof parsed.permission_mode === 'string') input.permission_mode = parsed.permission_mode
  if (isObject(parsed.mcp_server)) {
    const { name, source } = parsed.mcp_server
    input.mcp_server = {}
    if (typeof name === 'string') input.mcp_server.name = name
    if (typeof source === 'string') input.mcp_server.source = source
  }
  return input
}

async function recordAudit(
  auditDir: string,
  policy: HookPolicy,
  input: HookInput,
  result: HookResult,
  hookDecision: HookDecision,
): Promise<void> {
  const ts = new Date().toISOString()
  const run_id = `run_${Date.now().toString(36)}`
  // `executed` is what the hook knows when it exits. For an ask that is
  // false: the call runs only if the user approves it afterwards, which only
  // a PostToolUse hook can see. hook_decision says what the hook returned.
  const executed = hookDecision === 'allow'
  const trace_id = traceIdFromEnv() ?? null
  const server = input.mcp_server?.name ?? result.server
  const event = {
    ts,
    run_id,
    trace_id,
    decision_id: null,
    adapter: 'claude-code-hook',
    host: 'claude-code',
    server,
    server_source: input.mcp_server?.source ?? null,
    tool: result.effective_tool,
    args: input.tool_input,
    decision: result.decision,
    rule: result.rule,
    rule_kind: result.rule_kind,
    executed,
    hook_decision: hookDecision,
    policy_version: '1',
    schema_version: 1,
  }
  const writer = fileURLToPath(new URL('./audit-writer.js', import.meta.url))
  await writeAuditInChild(
    writer,
    { dir: auditDir, rotateDaily: policy.audit.rotate_daily, ts, line: JSON.stringify(event) + '\n' },
    AUDIT_DEADLINE_MS,
  )

  // Path B direct push to Cloud. A setup error here counts as an audit
  // failure. The push is fire-and-forget, and bin.ts exits right after
  // runHook returns, so today the request does not get sent; the local JSONL
  // above is the audit record.
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
      server,
      trace_id: trace_id ?? undefined,
      redactionMode: resolveArgsRedaction(),
    })
  }
}
