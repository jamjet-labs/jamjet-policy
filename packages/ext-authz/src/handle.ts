import type { PolicyEvaluator } from '@jamjet/cloud'
import type { AuthzHttpResult } from './types.js'
import { decidePolicy } from './policy.js'
import { parseAction } from './parse.js'
import { buildPolicyReceipt, appendReceipt, verdictToDecision, type PolicyReceipt } from './receipt.js'
import type { HoldStore } from './hold.js'

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

// Envoy sets x-envoy-auth-partial-body: true when the request body was truncated at
// max_request_bytes before reaching this PDP. We cannot trust a truncated body to
// reflect the real tool call, so we fail closed rather than evaluate a prefix.
function isPartialBody(headers: Record<string, string | undefined>): boolean {
  return headers['x-envoy-auth-partial-body'] === 'true'
}

function denyPartial(): AuthzHttpResult {
  return { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'partial_body_denied' }) }
}

export function handleAuthz(
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: AuthzDeps,
): AuthzHttpResult {
  if (isPartialBody(headers)) return denyPartial()
  // A non-tools/call MCP method (initialize, tools/list, notifications, ping) or a body
  // that is not a tool call passes through: this PDP governs tool execution, and the
  // upstream MCP server rejects anything it cannot parse. Use a strict, tools/call-only
  // proxy route if you need every payload to fail closed.
  const action = parseAction(rawBody, headers, deps.defaultServer)
  if (!action) return { status: 200, headers: {}, body: '' }

  const verdict = decidePolicy(deps.evaluator, action)
  const receipt = buildPolicyReceipt(action, verdictToDecision(verdict.kind), verdict.matchedPattern, deps.now())
  appendReceipt(deps.auditPath, receipt)

  if (verdict.kind === 'BLOCK') return deny403(verdict.reason, receipt)
  // ALLOW and (for now) PENDING both pass; PENDING is upgraded in M2.
  return { status: 200, headers: { 'x-jamjet-receipt': receipt.receipt_hash }, body: '' }
}

export interface AuthzDepsV2 extends AuthzDeps {
  holds: HoldStore
  approvalBaseUrl: string
}

// The runId is a deterministic, internal lookup key (a slice of the action hash), NOT a
// bearer token: approving requires CLI/filesystem access to the hold store, so its
// predictability is not itself a capability. `approval_url` targets a hosted approval
// endpoint (the Enterprise Gateway / Cloud); that web UI MUST mint its own random nonce
// rather than reuse this key. `approve_with` is the working path for the local CLI flow.
function stepUpChallenge(runId: string, approvalBaseUrl: string): AuthzHttpResult {
  const url = `${approvalBaseUrl}/${runId}`
  return {
    status: 403,
    headers: {
      'www-authenticate': `insufficient_scope, error_description="approval required", approval_id="${runId}"`,
      'x-jamjet-approval-id': runId,
      'x-jamjet-approval-url': url,
      'retry-after': '5',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      error: 'approval_required',
      approval_id: runId,
      approval_url: url,
      approve_with: `jamjet-ext-authz approve ${runId}`,
    }),
  }
}

export function handleAuthzWithHold(
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: AuthzDepsV2,
): AuthzHttpResult {
  if (isPartialBody(headers)) return denyPartial()
  const action = parseAction(rawBody, headers, deps.defaultServer)
  if (!action) return { status: 200, headers: {}, body: '' }

  const verdict = decidePolicy(deps.evaluator, action)

  if (verdict.kind === 'BLOCK') {
    const receipt = buildPolicyReceipt(action, 'BLOCKED', verdict.matchedPattern, deps.now())
    appendReceipt(deps.auditPath, receipt)
    return deny403(verdict.reason, receipt)
  }
  if (verdict.kind === 'ALLOW') {
    const receipt = buildPolicyReceipt(action, 'ALLOWED', verdict.matchedPattern, deps.now())
    appendReceipt(deps.auditPath, receipt)
    return { status: 200, headers: { 'x-jamjet-receipt': receipt.receipt_hash }, body: '' }
  }

  // PENDING: retry path if a hold already exists, else create one.
  const existing = deps.holds.find(action)
  if (existing) {
    const status = deps.holds.peek(existing.run_id)
    if (status === 'approved') {
      const receipt = buildPolicyReceipt(action, 'ALLOWED', verdict.matchedPattern, deps.now(), { run_id: existing.run_id, status: 'approved' })
      appendReceipt(deps.auditPath, receipt)
      // Single-use: consume the approval so the exact same action cannot be replayed.
      // A later identical request finds no hold, re-enters PENDING, and must be re-approved.
      deps.holds.consume(existing.run_id)
      return { status: 200, headers: { 'x-jamjet-receipt': receipt.receipt_hash }, body: '' }
    }
    if (status === 'rejected') {
      const receipt = buildPolicyReceipt(action, 'BLOCKED', verdict.matchedPattern, deps.now(), { run_id: existing.run_id, status: 'rejected' })
      appendReceipt(deps.auditPath, receipt)
      return deny403('approval rejected', receipt)
    }
    return stepUpChallenge(existing.run_id, deps.approvalBaseUrl)
  }

  const rec = deps.holds.hold(action, deps.now())
  const receipt = buildPolicyReceipt(action, 'WAITING_FOR_APPROVAL', verdict.matchedPattern, deps.now(), { run_id: rec.run_id, status: 'pending' })
  appendReceipt(deps.auditPath, receipt)
  return stepUpChallenge(rec.run_id, deps.approvalBaseUrl)
}
