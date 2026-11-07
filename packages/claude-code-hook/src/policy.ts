// Policy loading for the Claude Code hook.
//
// Same file format as the other JamJet adapters, but strict: anything this
// hook would not enforce is refused rather than ignored. An ignored key reads
// as a control that is not there (`default: block`, a rule-level `command:`
// narrowing an allow), and a pattern that can never match a Claude Code tool
// name is a rule that is not there.

import { readFileSync, statSync } from 'node:fs'
import { parse } from 'yaml'

export type PolicyAction = 'allow' | 'block' | 'require_approval' | 'audit'

export interface HookRule {
  match: string
  action: PolicyAction
}

export interface HookPolicy {
  rules: HookRule[]
  audit: { destination?: string; rotate_daily: boolean }
}

const MAX_POLICY_BYTES = 1024 * 1024
const ACTIONS: ReadonlySet<string> = new Set(['allow', 'block', 'require_approval', 'audit'])

// Claude Code only calls tools whose names the Claude API accepts:
// ^[a-zA-Z0-9_-]{1,128}$. MCP tools are mcp__<server>__<tool> within that.
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/
const PATTERN_CHARS = /^[A-Za-z0-9_\-*?]+$/
const MAX_PATTERN_LENGTH = 256

const TOP_LEVEL_HINTS: Record<string, string> = {
  budgets: 'budgets are not enforced by the Claude Code hook; use a policy file without them',
  default: 'default is not supported; end the rules with { match: "*", action: <action> } instead',
}
const RULE_HINTS: Record<string, string> = {
  approval_timeout: 'approval_timeout is not enforced by the Claude Code hook (Claude Code prompts have no timeout)',
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkKeys(where: string, obj: Record<string, unknown>, allowed: string[], hints: Record<string, string> = {}): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue
    const hint = hints[key]
    throw new Error(`${where} has an unknown key: ${key}${hint ? ` (${hint})` : ''}`)
  }
}

// Built-in tool names from code.claude.com/docs/en/tools-reference. Only used
// to catch a wrong-case spelling such as `bash`; matching is case-sensitive.
const BUILTIN_TOOLS = [
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit',
  'EndConversation', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep',
  'ListAgents', 'ListMcpResourcesTool', 'LSP', 'Monitor', 'NotebookEdit', 'PowerShell', 'PushNotification',
  'Read', 'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendFeedback',
  'SendMessage', 'SendUserFile', 'ShareOnboardingGuide', 'Skill', 'SubagentHandback', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
]
const BUILTIN_BY_LOWER = new Map(BUILTIN_TOOLS.map((t) => [t.toLowerCase(), t]))

/** Why a pattern can never match a Claude Code tool name, or null if it can. */
export function deadPatternReason(pattern: string): string | null {
  if (pattern === '') return 'is empty'
  if (pattern.length > MAX_PATTERN_LENGTH) return `is longer than ${MAX_PATTERN_LENGTH} characters`
  if (!PATTERN_CHARS.test(pattern)) {
    return 'has characters no Claude Code tool name contains (names use only A-Z a-z 0-9 _ -, plus * and ? as wildcards)'
  }
  if (pattern.replace(/\*/g, '').length > 128) return 'needs more than 128 characters, the longest tool name'
  // A literal start that spells a built-in name in the wrong case (`bash`,
  // `bash*`, `webFetch?`) is a typo for the built-in.
  const literal = pattern.split(/[*?]/, 1)[0]!
  const builtin = BUILTIN_BY_LOWER.get(literal.toLowerCase())
  if (builtin !== undefined && builtin !== literal) {
    return `starts with ${literal}, which differs in case from the built-in tool ${builtin} (matching is case-sensitive; for MCP tools write mcp__*__${pattern})`
  }
  return null
}

export function loadHookPolicy(path: string): HookPolicy {
  // A FIFO or device would block readFileSync until Claude Code's hook
  // timeout, and a timed-out hook lets the tool run.
  const st = statSync(path)
  if (!st.isFile()) throw new Error('not a regular file')
  if (st.size > MAX_POLICY_BYTES) throw new Error(`larger than ${MAX_POLICY_BYTES} bytes`)

  const doc: unknown = parse(readFileSync(path, 'utf-8'))
  if (!isObject(doc)) throw new Error('must be a mapping with version and rules')
  checkKeys('policy', doc, ['version', 'rules', 'audit'], TOP_LEVEL_HINTS)
  if (doc.version !== 1) throw new Error(`unsupported policy version: ${String(doc.version)}`)
  if (!Array.isArray(doc.rules)) throw new Error('rules must be a list')

  const rules = doc.rules.map((raw: unknown, i: number): HookRule => {
    if (!isObject(raw)) throw new Error(`rule[${i}] must be a mapping`)
    checkKeys(`rule[${i}]`, raw, ['match', 'action'], RULE_HINTS)
    const { match, action } = raw
    if (typeof match !== 'string') throw new Error(`rule[${i}].match must be a string`)
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      throw new Error(`rule[${i}]: unknown action: ${String(action)}`)
    }
    const dead = deadPatternReason(match)
    if (dead) throw new Error(`rule[${i}].match ${JSON.stringify(match)} can never match: it ${dead}`)
    return { match, action: action as PolicyAction }
  })

  const audit: HookPolicy['audit'] = { rotate_daily: true }
  if (doc.audit !== undefined) {
    if (!isObject(doc.audit)) throw new Error('audit must be a mapping')
    checkKeys('audit', doc.audit, ['destination', 'rotate_daily'])
    const { destination, rotate_daily } = doc.audit
    if (destination !== undefined) {
      if (typeof destination !== 'string' || destination === '') {
        throw new Error('audit.destination must be a non-empty string')
      }
      audit.destination = destination
    }
    if (rotate_daily !== undefined) {
      if (typeof rotate_daily !== 'boolean') throw new Error('audit.rotate_daily must be true or false')
      audit.rotate_daily = rotate_daily
    }
  }
  return { rules, audit }
}
