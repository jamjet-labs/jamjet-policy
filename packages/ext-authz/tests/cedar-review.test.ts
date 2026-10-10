import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvaluator, buildCedar } from '../src/policy.js'
import { createHoldStore, type HoldStore } from '../src/hold.js'
import { handleAuthz, handleAuthzWithHold, type AuthzDepsV2 } from '../src/handle.js'
import { handleAuthZen, AUTHZEN_EVALUATION_PATH } from '../src/authzen.js'

const NO_RULES = 'version: 1\nrules: []\n'

function deps(yaml: string, cedarText: string | null, extra: Partial<AuthzDepsV2> = {}): AuthzDepsV2 {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-review-'))
  writeFileSync(join(dir, 'policy.yaml'), yaml, 'utf-8')
  let cedar = null
  if (cedarText !== null) {
    writeFileSync(join(dir, 'p.cedar'), cedarText, 'utf-8')
    cedar = buildCedar(join(dir, 'p.cedar'))
  }
  return {
    evaluator: buildEvaluator(join(dir, 'policy.yaml')),
    cedar,
    auditPath: join(dir, 'r.jsonl'),
    now: () => '2026-10-11T00:00:00.000Z',
    defaultServer: 'mcp',
    holds: createHoldStore(join(dir, 'holds')),
    approvalBaseUrl: 'http://localhost:9191/approve',
    ...extra,
  }
}

function rpc(tool: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
}

function zen(d: AuthzDepsV2, body: Record<string, unknown>) {
  const res = handleAuthZen(AUTHZEN_EVALUATION_PATH, 'POST', JSON.stringify(body), {}, d)
  return { status: res.status, json: JSON.parse(res.body) }
}

function req(tool: string, subject: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { subject, action: { name: tool }, resource: { type: 'mcp_tool', id: tool, properties: { server: 'crm', arguments: { amount: 5 } } }, ...extra }
}

const FORBID_PAYMENTS = 'permit (principal, action, resource);\nforbid (principal, action, resource in JamJet::Server::"payments");'

describe('review 1: the server name is not taken from client headers when Cedar is loaded', () => {
  it('ignores Host and x-jamjet-server and uses --server-name', () => {
    const d = deps(NO_RULES, FORBID_PAYMENTS, { defaultServer: 'payments' })
    for (const headers of [{ host: 'payments' }, { host: 'PAYMENTS' }, { host: 'payments:443' }, { host: 'payments.' }, { host: 'payments', 'x-jamjet-server': 'crm' }]) {
      expect(handleAuthzWithHold(rpc('transfer'), headers, d).status).toBe(403)
    }
  })

  it('reads an operator-named server header, normalized', () => {
    const d = deps(NO_RULES, FORBID_PAYMENTS, { serverHeader: 'x-upstream' })
    expect(handleAuthzWithHold(rpc('transfer'), { 'x-upstream': 'PAYMENTS:443' }, d).status).toBe(403)
    expect(handleAuthzWithHold(rpc('transfer'), { 'x-upstream': 'payments.' }, d).status).toBe(403)
    expect(handleAuthzWithHold(rpc('transfer'), { 'x-upstream': 'crm' }, d).status).toBe(200)
  })

  it('blocks when the operator-named server header is missing', () => {
    const d = deps(NO_RULES, FORBID_PAYMENTS, { serverHeader: 'x-upstream' })
    expect(handleAuthzWithHold(rpc('transfer'), { host: 'crm' }, d).status).toBe(403)
  })
})

describe('review 2: non-string AuthZen subject claims', () => {
  const SUSPENDED = 'permit (principal, action, resource);\nforbid (principal, action, resource) when { principal.hasTag("suspended") };'
  it('scalars become string tags so tag forbids still fire', () => {
    const d = deps(NO_RULES, SUSPENDED)
    for (const v of ['yes', true, 1]) {
      const r = zen(d, req('refund', { type: 'agent', id: 'bob', properties: { suspended: v } }))
      expect(r.status).toBe(200)
      expect(r.json.decision).toBe(false)
    }
  })
  it('array or object claims are a 400 when Cedar is loaded', () => {
    const d = deps(NO_RULES, SUSPENDED)
    expect(zen(d, req('refund', { type: 'agent', id: 'bob', properties: { suspended: ['x'] } })).status).toBe(400)
    expect(zen(d, req('refund', { type: 'agent', id: 'bob', properties: { suspended: { a: 1 } } })).status).toBe(400)
  })
})

describe('review 4: an approval is bound to the evaluated context', () => {
  const HOLD = '@require_approval permit (principal, action, resource);'
  function approveFirst(d: AuthzDepsV2) {
    const first = zen(d, req('refund', { type: 'agent', id: 'bob', properties: { team: 'support' } }, { context: { risk: 'low' } }))
    expect(first.json.decision).toBe(false)
    d.holds.resolve(first.json.context.jamjet.approval_id, 'approved')
  }
  it('a different subject type does not spend it', () => {
    const d = deps(NO_RULES, HOLD)
    approveFirst(d)
    expect(zen(d, req('refund', { type: 'user', id: 'bob', properties: { team: 'support' } }, { context: { risk: 'low' } })).json.decision).toBe(false)
  })
  it('different claims do not spend it', () => {
    const d = deps(NO_RULES, HOLD)
    approveFirst(d)
    expect(zen(d, req('refund', { type: 'agent', id: 'bob', properties: { team: 'contractors' } }, { context: { risk: 'low' } })).json.decision).toBe(false)
  })
  it('a different risk does not spend it', () => {
    const d = deps(NO_RULES, HOLD)
    approveFirst(d)
    expect(zen(d, req('refund', { type: 'agent', id: 'bob', properties: { team: 'support' } }, { context: { risk: 'critical' } })).json.decision).toBe(false)
  })
  it('the same context does (control)', () => {
    const d = deps(NO_RULES, HOLD)
    approveFirst(d)
    expect(zen(d, req('refund', { type: 'agent', id: 'bob', properties: { team: 'support' } }, { context: { risk: 'low' } })).json.decision).toBe(true)
  })
  it('the hold record shows the approver who asked and at what risk', () => {
    const d = deps(NO_RULES, HOLD)
    const first = zen(d, req('refund', { type: 'agent', id: 'bob', properties: { team: 'support' } }, { context: { risk: 'low' } }))
    const rec = d.holds.find({ server: 'crm', tool: 'refund', args: { amount: 5 }, principal: { id: 'bob', kind: 'agent', tags: { team: 'support' } }, risk: 'low' })
    expect(rec?.run_id).toBe(first.json.context.jamjet.approval_id)
    expect(rec?.principal).toEqual({ id: 'bob', kind: 'agent', tags: { team: 'support' } })
    expect(rec?.risk).toBe('low')
  })
})

describe('review 8: the hold-less handler never passes a hold', () => {
  it('returns 403 for require_approval', () => {
    const d = deps('version: 1\nrules:\n  - match: "pay"\n    action: require_approval\n', null)
    expect(handleAuthz(rpc('pay'), {}, d).status).toBe(403)
    const c = deps(NO_RULES, '@require_approval permit (principal, action, resource);')
    expect(handleAuthz(rpc('pay'), {}, c).status).toBe(403)
  })
})

describe('review 9: an approval is used only if this request consumed it', () => {
  function raceHolds(inner: HoldStore): HoldStore {
    // Another replica consumed the approval between peek and consume.
    return { ...inner, consume: () => false }
  }
  it('YAML hold path: approved but not consumed here is not allowed', () => {
    const d = deps('version: 1\nrules:\n  - match: "pay"\n    action: require_approval\n', null)
    const runId = handleAuthzWithHold(rpc('pay'), {}, d).headers['x-jamjet-approval-id']!
    d.holds.resolve(runId, 'approved')
    const raced = { ...d, holds: raceHolds(d.holds) }
    expect(handleAuthzWithHold(rpc('pay'), {}, raced).status).toBe(403)
  })
  it('Cedar approval_status path: approved but not consumed here is not allowed', () => {
    const d = deps(
      NO_RULES,
      `permit (principal, action, resource) when { context.approval_status == "approved" };
@require_approval permit (principal, action, resource) when { context.approval_status != "approved" };`,
    )
    const runId = handleAuthzWithHold(rpc('pay'), {}, d).headers['x-jamjet-approval-id']!
    d.holds.resolve(runId, 'approved')
    const raced = { ...d, holds: raceHolds(d.holds) }
    expect(handleAuthzWithHold(rpc('pay'), {}, raced).status).toBe(403)
  })
  for (const [label, yaml, cedarText] of [
    ['AuthZen Cedar approval_status path', NO_RULES, `permit (principal, action, resource) when { context.approval_status == "approved" };
@require_approval permit (principal, action, resource) when { context.approval_status != "approved" };`],
    ['AuthZen YAML hold path', 'version: 1\nrules:\n  - match: "pay"\n    action: require_approval\n', null],
  ] as const) {
    it(`${label}: approved but not consumed here is not allowed`, () => {
      const d = deps(yaml, cedarText)
      const body = req('pay', { type: 'agent', id: 'x' })
      const first = zen(d, body)
      d.holds.resolve(first.json.context.jamjet.approval_id, 'approved')
      expect(zen({ ...d, holds: raceHolds(d.holds) }, body).json.decision).toBe(false)
      // Control: the same request against the real store is allowed once.
      expect(zen(d, body).json.decision).toBe(true)
    })
  }
  it('consume on the real store reports false the second time', () => {
    const d = deps('version: 1\nrules:\n  - match: "pay"\n    action: require_approval\n', null)
    const rec = d.holds.hold({ server: 's', tool: 'pay', args: {} }, 'now')
    expect(d.holds.consume(rec.run_id)).toBe(true)
    expect(d.holds.consume(rec.run_id)).toBe(false)
  })
})

describe('review 10: the AuthZen resource id must name the evaluated tool when Cedar is loaded', () => {
  const ALLOW = 'permit (principal, action, resource);'
  it('accepts resource.id equal to the action name or <server>___<tool>', () => {
    const d = deps(NO_RULES, ALLOW)
    expect(zen(d, req('refund', { type: 'agent', id: 'a' })).status).toBe(200)
    const body = req('refund', { type: 'agent', id: 'a' })
    ;(body.resource as Record<string, unknown>).id = 'crm___refund'
    expect(zen(d, body).status).toBe(200)
  })
  it('rejects a resource.id that names a different tool', () => {
    const d = deps(NO_RULES, ALLOW)
    const body = req('refund', { type: 'agent', id: 'a' })
    ;(body.resource as Record<string, unknown>).id = 'payments___refund'
    expect(zen(d, body).status).toBe(400)
  })
})
