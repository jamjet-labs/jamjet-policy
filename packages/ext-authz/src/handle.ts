import type { PolicyEvaluator } from '@jamjet/cloud'
import type { AuthzHttpResult } from './types.js'
import { decidePolicy } from './policy.js'
import { parseAction } from './parse.js'
import { buildPolicyReceipt, appendReceipt, verdictToDecision, type PolicyReceipt } from './receipt.js'

export interface AuthzDeps {
  evaluator: PolicyEvaluator
  auditPath: string
  now: () => string
  defaultServer: string
}

function deny403(reason: string, receipt: PolicyReceipt): AuthzHttpResult {
  return {
    status: 403,
    headers: { 'x-jamjet-receipt': receipt.receipt_hash, 'content-type': 'application/json' },
    body: JSON.stringify({ error: reason, receipt: receipt.receipt_hash }),
  }
}

export function handleAuthz(
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: AuthzDeps,
): AuthzHttpResult {
  const action = parseAction(rawBody, headers, deps.defaultServer)
  if (!action) return { status: 200, headers: {}, body: '' }

  const verdict = decidePolicy(deps.evaluator, action)
  const receipt = buildPolicyReceipt(action, verdictToDecision(verdict.kind), verdict.matchedPattern, deps.now())
  appendReceipt(deps.auditPath, receipt)

  if (verdict.kind === 'BLOCK') return deny403(verdict.reason, receipt)
  // ALLOW and (for now) PENDING both pass; PENDING is upgraded in M2.
  return { status: 200, headers: { 'x-jamjet-receipt': receipt.receipt_hash }, body: '' }
}
