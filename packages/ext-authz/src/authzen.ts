// OpenID AuthZen Authorization API 1.0 surface for the JamJet PDP, per the AuthZen
// MCP profile: the MCP gateway/server is the PEP; this service is the PDP.
// Single evaluation:  POST /access/v1/evaluation
// Batch evaluations:  POST /access/v1/evaluations
// A deny is HTTP 200 with { decision: false }; HTTP errors are reserved for malformed
// requests (400) and server faults (500). The require_approval hold maps to a deny whose
// context carries step-up instructions, which the AuthZen spec explicitly permits.
import type { AuthzAction, AuthzHttpResult } from './types.js'
import type { AuthzDepsV2 } from './handle.js'
import { decidePolicy } from './policy.js'
import { buildPolicyReceipt, appendReceipt } from './receipt.js'

export const AUTHZEN_EVALUATION_PATH = '/access/v1/evaluation'
export const AUTHZEN_EVALUATIONS_PATH = '/access/v1/evaluations'
const AUTHZEN_PREFIX = '/access/'

export function isAuthZenPath(path: string): boolean {
  return path.startsWith(AUTHZEN_PREFIX)
}

interface AuthZenDecision {
  decision: boolean
  context: Record<string, unknown>
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Parse one AuthZen evaluation request (subject/action/resource[/context]) into the
// policy-engine action. Returns a string error label on any shape violation: the caller
// fails closed with a 400 rather than evaluating a guessed action.
function parseEvaluation(req: Record<string, unknown>, defaultServer: string): AuthzAction | string {
  const subject = req.subject
  if (!isPlainObject(subject) || typeof subject.type !== 'string' || typeof subject.id !== 'string') {
    return 'subject with string type and id is required'
  }
  const action = req.action
  if (!isPlainObject(action) || typeof action.name !== 'string') {
    return 'action with string name is required'
  }
  const resource = req.resource
  if (!isPlainObject(resource) || typeof resource.type !== 'string' || typeof resource.id !== 'string') {
    return 'resource with string type and id is required'
  }

  const props = isPlainObject(resource.properties) ? resource.properties : {}
  let args: Record<string, unknown> = {}
  if (props.arguments !== undefined) {
    if (!isPlainObject(props.arguments)) return 'resource.properties.arguments must be an object'
    args = props.arguments
  }
  const server = typeof props.server === 'string' ? props.server : defaultServer
  return { server, tool: action.name, args }
}

// Same decision flow as the ext_authz handler (block / allow / hold with single-use
// approval), rendered as an AuthZen decision instead of an HTTP status.
function evaluateOne(action: AuthzAction, deps: AuthzDepsV2): AuthZenDecision {
  const verdict = decidePolicy(deps.evaluator, action)

  if (verdict.kind === 'BLOCK') {
    const receipt = buildPolicyReceipt(action, 'BLOCKED', verdict.matchedPattern, deps.now())
    appendReceipt(deps.auditPath, receipt)
    return { decision: false, context: { reason_user: verdict.reason, receipt: receipt.receipt_hash } }
  }
  if (verdict.kind === 'ALLOW') {
    const receipt = buildPolicyReceipt(action, 'ALLOWED', verdict.matchedPattern, deps.now())
    appendReceipt(deps.auditPath, receipt)
    return { decision: true, context: { receipt: receipt.receipt_hash } }
  }

  // PENDING: reuse the hold store. Approved holds permit exactly once.
  const existing = deps.holds.find(action)
  if (existing) {
    const status = deps.holds.peek(existing.run_id)
    if (status === 'approved') {
      const receipt = buildPolicyReceipt(action, 'ALLOWED', verdict.matchedPattern, deps.now(), {
        run_id: existing.run_id,
        status: 'approved',
      })
      appendReceipt(deps.auditPath, receipt)
      deps.holds.consume(existing.run_id)
      return { decision: true, context: { receipt: receipt.receipt_hash } }
    }
    if (status === 'rejected') {
      const receipt = buildPolicyReceipt(action, 'BLOCKED', verdict.matchedPattern, deps.now(), {
        run_id: existing.run_id,
        status: 'rejected',
      })
      appendReceipt(deps.auditPath, receipt)
      return {
        decision: false,
        context: {
          reason: 'approval_rejected',
          receipt: receipt.receipt_hash,
          jamjet: { approval_id: existing.run_id, status: 'rejected' },
        },
      }
    }
    return pendingDecision(existing.run_id, deps)
  }

  const rec = deps.holds.hold(action, deps.now())
  const receipt = buildPolicyReceipt(action, 'WAITING_FOR_APPROVAL', verdict.matchedPattern, deps.now(), {
    run_id: rec.run_id,
    status: 'pending',
  })
  appendReceipt(deps.auditPath, receipt)
  return pendingDecision(rec.run_id, deps, receipt.receipt_hash)
}

function pendingDecision(runId: string, deps: AuthzDepsV2, receiptHash?: string): AuthZenDecision {
  return {
    decision: false,
    context: {
      reason: 'approval_required',
      ...(receiptHash ? { receipt: receiptHash } : {}),
      jamjet: {
        approval_id: runId,
        approval_url: `${deps.approvalBaseUrl}/${runId}`,
        approve_with: `jamjet-ext-authz approve ${runId}`,
        status: 'pending',
      },
    },
  }
}

// Response headers may echo X-Request-ID, which is caller-supplied: strip anything
// outside printable ASCII so the echo cannot smuggle header control characters, and
// bound its length.
function echoHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = { 'content-type': 'application/json' }
  const rid = headers['x-request-id']
  if (typeof rid === 'string' && rid.length > 0) {
    const clean = rid.replace(/[^\x20-\x7e]/g, '').slice(0, 128)
    if (clean) base['x-request-id'] = clean
  }
  return base
}

function respond(status: number, body: unknown, headers: Record<string, string | undefined>): AuthzHttpResult {
  return { status, headers: echoHeaders(headers), body: JSON.stringify(body) }
}

const SEMANTICS = ['execute_all', 'deny_on_first_deny', 'permit_on_first_permit'] as const
type EvaluationsSemantic = (typeof SEMANTICS)[number]

// Each batch item can mint a receipt and create a hold (two file writes), so the batch
// size bounds disk amplification, not just CPU. 64 is far above any real PEP batch.
const MAX_BATCH_EVALUATIONS = 64

export function handleAuthZen(
  path: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: AuthzDepsV2,
): AuthzHttpResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return respond(400, { error: 'invalid_json' }, headers)
  }
  if (!isPlainObject(parsed)) return respond(400, { error: 'invalid_request' }, headers)

  if (path === AUTHZEN_EVALUATION_PATH) {
    const action = parseEvaluation(parsed, deps.defaultServer)
    if (typeof action === 'string') return respond(400, { error: 'invalid_request', detail: action }, headers)
    return respond(200, evaluateOne(action, deps), headers)
  }

  if (path === AUTHZEN_EVALUATIONS_PATH) {
    const items = parsed.evaluations
    if (!Array.isArray(items) || items.length === 0) {
      return respond(400, { error: 'invalid_request', detail: 'evaluations must be a non-empty array' }, headers)
    }
    if (items.length > MAX_BATCH_EVALUATIONS) {
      return respond(400, { error: 'invalid_request', detail: `evaluations exceeds the maximum of ${MAX_BATCH_EVALUATIONS}` }, headers)
    }
    const options = isPlainObject(parsed.options) ? parsed.options : {}
    const semantic: EvaluationsSemantic = SEMANTICS.includes(options.evaluations_semantic as EvaluationsSemantic)
      ? (options.evaluations_semantic as EvaluationsSemantic)
      : 'execute_all'

    const results: AuthZenDecision[] = []
    for (const item of items) {
      const merged: Record<string, unknown> = isPlainObject(item)
        ? {
            subject: item.subject ?? parsed.subject,
            action: item.action ?? parsed.action,
            resource: item.resource ?? parsed.resource,
            context: item.context ?? parsed.context,
          }
        : {}
      const action = parseEvaluation(merged, deps.defaultServer)
      // Fail closed per item: a malformed entry is a deny with a reason, and the
      // batch keeps its positional alignment with the request.
      const result =
        typeof action === 'string'
          ? { decision: false, context: { reason_admin: `invalid evaluation: ${action}` } }
          : evaluateOne(action, deps)
      results.push(result)
      if (semantic === 'deny_on_first_deny' && !result.decision) break
      if (semantic === 'permit_on_first_permit' && result.decision) break
    }
    return respond(200, { evaluations: results }, headers)
  }

  return respond(404, { error: 'not_found' }, headers)
}
