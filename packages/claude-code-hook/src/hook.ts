// src/hook.ts
import type { PolicyEvaluator } from '@jamjet/cloud'
import { parseClaudeToolName } from './claude-tool-name.js'

export interface HookInput {
  tool_name: string
  tool_input: Record<string, unknown>
  session_id?: string
}

export interface HookResult {
  decision: 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'AUDIT'
  rule: string | null
  rule_kind: 'allow' | 'block' | 'require_approval' | 'audit' | null
  exit_code: 0 | 2
  effective_tool: string
  server: string | null
}

export function evaluateHookInput(input: HookInput, policy: PolicyEvaluator): HookResult {
  const parsed = parseClaudeToolName(input.tool_name)
  const d = policy.evaluate(parsed.effective)

  if (d.blocked) {
    return {
      decision: 'BLOCKED',
      rule: d.pattern,
      rule_kind: 'block',
      exit_code: 2,
      effective_tool: parsed.effective,
      server: parsed.server,
    }
  }
  if (d.policyKind === 'require_approval') {
    return {
      decision: 'WAITING_FOR_APPROVAL',
      rule: d.pattern,
      rule_kind: 'require_approval',
      exit_code: 2,
      effective_tool: parsed.effective,
      server: parsed.server,
    }
  }
  if (d.policyKind === 'audit') {
    return {
      decision: 'AUDIT',
      rule: d.pattern,
      rule_kind: 'audit',
      exit_code: 0,
      effective_tool: parsed.effective,
      server: parsed.server,
    }
  }
  return {
    decision: 'ALLOWED',
    rule: d.pattern ?? null,
    rule_kind: d.pattern ? 'allow' : null,
    exit_code: 0,
    effective_tool: parsed.effective,
    server: parsed.server,
  }
}
