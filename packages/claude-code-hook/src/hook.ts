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

const MCP_PREFIX = 'mcp__'

/**
 * The possible bare tool names of an MCP tool, or null for a built-in.
 *
 * Server names may contain `__` and may start or end with `_`, so the text
 * `mcp__a__b__c` does not say where the server ends. When Claude Code sends
 * `mcp_server.name`, strip exactly `mcp__<name>__`, with the name normalised
 * the way Claude Code does it (anything outside A-Z a-z 0-9 _ - becomes _).
 * Otherwise return every possible split, so a restrictive rule applies if
 * any reading of the name matches it.
 */
export function mcpBareNames(toolName: string, serverName: string | undefined): { names: string[]; exact: boolean } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null
  if (serverName !== undefined && serverName !== '') {
    const prefix = `${MCP_PREFIX}${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}__`
    if (toolName.length > prefix.length && toolName.startsWith(prefix)) {
      return { names: [toolName.slice(prefix.length)], exact: true }
    }
  }
  const names: string[] = []
  // i is where a "__" could end the server name: at least one character of
  // server before it and one character of tool after it.
  for (let i = MCP_PREFIX.length + 1; i + 2 < toolName.length; i++) {
    if (toolName[i] === '_' && toolName[i + 1] === '_') names.push(toolName.slice(i + 2))
  }
  return { names, exact: false }
}

/**
 * Rules are checked in order and the first match wins. Every rule matches
 * against the full tool name. For an MCP tool (`mcp__<server>__<tool>`), a
 * rule that blocks, asks or audits also matches the bare tool name (every
 * possible one, when the server name is unknown), so `*delete*` and
 * `merge_pull_request` work whatever the server is called. An allow rule
 * only ever matches the full name: an MCP tool is allowed by
 * `mcp__github__*` or `mcp__*__query`, never by an allow written for a
 * built-in such as `Read`.
 */
export function evaluateHookInput(input: HookInput, rules: readonly HookRule[]): HookResult {
  const full = input.tool_name
  const bare = mcpBareNames(full, input.mcp_server?.name)
  const parsed = parseClaudeToolName(full)
  const effective_tool = bare?.exact ? bare.names[0]! : parsed.effective
  const server = bare?.exact ? input.mcp_server!.name! : parsed.server
  for (const r of rules) {
    const matches =
      globMatch(r.match, full) || (bare !== null && r.action !== 'allow' && bare.names.some((b) => globMatch(r.match, b)))
    if (matches) {
      return { decision: DECISION[r.action], rule: r.match, rule_kind: r.action, effective_tool, server }
    }
  }
  return { decision: 'ALLOWED', rule: null, rule_kind: null, effective_tool, server }
}
