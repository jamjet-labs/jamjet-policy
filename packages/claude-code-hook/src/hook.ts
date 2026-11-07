// src/hook.ts
import { parseClaudeToolName } from './claude-tool-name.js'
import { globMatch } from './glob.js'
import type { HookRule } from './policy.js'

export interface HookInput {
  tool_name: string
  tool_input: Record<string, unknown>
  session_id?: string
  permission_mode?: string
  mcp_server?: { name?: string; source?: string }
}

export type Decision = 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'AUDIT'
export type RuleKind = 'allow' | 'block' | 'require_approval' | 'audit'

export interface HookResult {
  decision: Decision
  rule: string | null
  rule_kind: RuleKind | null
  effective_tool: string
  server: string | null
}

const DECISION: Record<RuleKind, Decision> = {
  allow: 'ALLOWED',
  block: 'BLOCKED',
  require_approval: 'WAITING_FOR_APPROVAL',
  audit: 'AUDIT',
}

/**
 * Rules are checked in order and the first match wins. Every rule matches
 * against the full tool name. For an MCP tool (`mcp__<server>__<tool>`), a
 * rule that blocks, asks or audits also matches the bare tool name, so
 * `*delete*` and `merge_pull_request` work whatever the server is called. An
 * allow rule only ever matches the full name: an MCP tool is allowed by
 * `mcp__github__*` or `mcp__*__query`, never by an allow written for a
 * built-in such as `Read`.
 */
export function evaluateHookInput(input: HookInput, rules: readonly HookRule[]): HookResult {
  const parsed = parseClaudeToolName(input.tool_name)
  const isMcp = parsed.server !== null
  for (const r of rules) {
    const matches =
      globMatch(r.match, parsed.raw) || (isMcp && r.action !== 'allow' && globMatch(r.match, parsed.effective))
    if (matches) {
      return {
        decision: DECISION[r.action],
        rule: r.match,
        rule_kind: r.action,
        effective_tool: parsed.effective,
        server: parsed.server,
      }
    }
  }
  return { decision: 'ALLOWED', rule: null, rule_kind: null, effective_tool: parsed.effective, server: parsed.server }
}
