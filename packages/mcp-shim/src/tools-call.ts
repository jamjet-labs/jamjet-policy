import type { PolicyEvaluator } from '@jamjet/cloud'
import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js'

export interface ToolsCallInterception {
  decision: 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'AUDIT'
  rule: string | null
  rule_kind: 'allow' | 'block' | 'require_approval' | 'audit' | null
  tool: string
  args: Record<string, unknown>
}

export function interceptToolsCall(
  req: JsonRpcRequest,
  policy: PolicyEvaluator,
): ToolsCallInterception | null {
  if (req.method !== 'tools/call') return null
  const name = (req.params?.name as string) ?? ''
  const args = (req.params?.arguments as Record<string, unknown>) ?? {}
  const d = policy.evaluate(name)

  if (d.blocked) {
    return { decision: 'BLOCKED', rule: d.pattern, rule_kind: 'block', tool: name, args }
  }
  // PolicyDecision uses camelCase `policyKind`
  if (d.policyKind === 'require_approval') {
    return { decision: 'WAITING_FOR_APPROVAL', rule: d.pattern, rule_kind: 'require_approval', tool: name, args }
  }
  if (d.policyKind === 'audit') {
    return { decision: 'AUDIT', rule: d.pattern, rule_kind: 'audit', tool: name, args }
  }
  return { decision: 'ALLOWED', rule: d.pattern ?? null, rule_kind: d.pattern ? 'allow' : null, tool: name, args }
}

export function blockResponse(id: number | string, rule: string | null): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `JamJet policy: BLOCKED (rule: ${rule ?? 'unknown'})`,
    },
  }
}
