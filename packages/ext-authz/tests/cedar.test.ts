import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CedarLoadError } from '@jamjet/cedar'
import { buildEvaluator, buildCedar } from '../src/policy.js'
import { createHoldStore } from '../src/hold.js'
import { handleAuthzWithHold, type AuthzDepsV2 } from '../src/handle.js'
import { handleAuthZen, AUTHZEN_EVALUATION_PATH } from '../src/authzen.js'

const INPUT = 'namespace JamJet::Input { type ToolInput = { amount?: Long }; }'

function deps(yaml: string, cedarText: string | null, extra: Partial<AuthzDepsV2> = {}): AuthzDepsV2 {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-cedar-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, yaml, 'utf-8')
  let cedar = null
  if (cedarText !== null) {
    writeFileSync(join(dir, 'p.cedar'), cedarText, 'utf-8')
    writeFileSync(join(dir, 'input.cedarschema'), INPUT, 'utf-8')
    cedar = buildCedar(join(dir, 'p.cedar'), join(dir, 'input.cedarschema'))
  }
  return {
    evaluator: buildEvaluator(policyPath),
    cedar,
    auditPath: join(dir, 'r.jsonl'),
    now: () => '2026-10-11T00:00:00.000Z',
    defaultServer: 'mcp',
    holds: createHoldStore(join(dir, 'holds')),
    approvalBaseUrl: 'http://localhost:9191/approve',
    ...extra,
  }
}

const NO_RULES = 'version: 1\nrules: []\n'

function rpc(tool: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
}

function zen(d: AuthzDepsV2, tool: string, opts: { subject?: Record<string, unknown>; args?: Record<string, unknown>; context?: Record<string, unknown> } = {}) {
  const body = JSON.stringify({
    subject: opts.subject ?? { type: 'agent', id: 'agent-1' },
    action: { name: tool },
    resource: { type: 'mcp_tool', id: tool, properties: { server: 'RefundTool', arguments: opts.args ?? {} } },
    ...(opts.context ? { context: opts.context } : {}),
  })
  return JSON.parse(handleAuthZen(AUTHZEN_EVALUATION_PATH, 'POST', body, {}, d).body)
}

function lastReceipt(d: AuthzDepsV2) {
  const lines = readFileSync(d.auditPath, 'utf-8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!)
}

describe('ext_authz with Cedar', () => {
  const CEDAR = `
@id("allow-search") permit (principal, action, resource) when { resource.name == "search" };
@id("allow-drop") permit (principal, action, resource) when { resource.name == "drop_table" };
@id("no-drop") forbid (principal, action, resource) when { resource.name == "drop_table" };
@id("hold-pay") @require_approval permit (principal, action, resource) when { resource.name == "pay" };
`
  it('permit: 200', () => {
    expect(handleAuthzWithHold(rpc('search'), {}, deps(NO_RULES, CEDAR)).status).toBe(200)
  })

  it('forbid: 403 with the Cedar policy id in the receipt', () => {
    const d = deps(NO_RULES, CEDAR)
    const res = handleAuthzWithHold(rpc('drop_table'), {}, d)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/no-drop/)
    expect(lastReceipt(d).policy.matched_pattern).toBe('cedar:no-drop')
  })

  it('Cedar default deny wins over the YAML no-match allow', () => {
    expect(handleAuthzWithHold(rpc('unlisted_tool'), {}, deps(NO_RULES, CEDAR)).status).toBe(403)
  })

  it('YAML block wins over a Cedar permit', () => {
    const yaml = 'version: 1\nrules:\n  - match: "search"\n    action: block\n'
    expect(handleAuthzWithHold(rpc('search'), {}, deps(yaml, CEDAR)).status).toBe(403)
  })

  it('require-approval: holds, permits exactly once after approval, then holds again', () => {
    const d = deps(NO_RULES, CEDAR)
    const first = handleAuthzWithHold(rpc('pay', { amount: 5 }), {}, d)
    expect(first.status).toBe(403)
    const runId = first.headers['x-jamjet-approval-id']!
    expect(runId).toMatch(/^run_/)
    d.holds.resolve(runId, 'approved')
    expect(handleAuthzWithHold(rpc('pay', { amount: 5 }), {}, d).status).toBe(200)
    const replay = handleAuthzWithHold(rpc('pay', { amount: 5 }), {}, d)
    expect(replay.status).toBe(403)
    expect(replay.headers['x-jamjet-approval-id']).toBe(runId)
  })

  it('approval_status in context reflects the hold, and an approval it unlocks is single-use', () => {
    // AWS AgentCore pattern: permit only once approved, hold otherwise.
    const AWS_STYLE = `
@id("approved-pay") permit (principal, action, resource) when { resource.name == "pay" && context.approval_status == "approved" };
@id("ask-pay") @require_approval permit (principal, action, resource) when { resource.name == "pay" && context.approval_status != "approved" };
`
    const d = deps(NO_RULES, AWS_STYLE)
    const first = handleAuthzWithHold(rpc('pay'), {}, d)
    expect(first.status).toBe(403)
    const runId = first.headers['x-jamjet-approval-id']!
    d.holds.resolve(runId, 'approved')
    const ok = handleAuthzWithHold(rpc('pay'), {}, d)
    expect(ok.status).toBe(200)
    expect(lastReceipt(d).policy.matched_pattern).toBe('cedar:approved-pay')
    expect(lastReceipt(d).approval).toEqual({ run_id: runId, status: 'approved' })
    // The approval was consumed: the same call is held again, not allowed again.
    expect(handleAuthzWithHold(rpc('pay'), {}, d).status).toBe(403)
  })

  it('a rejected hold blocks even when Cedar would permit', () => {
    const d = deps(NO_RULES, CEDAR)
    const runId = handleAuthzWithHold(rpc('pay'), {}, d).headers['x-jamjet-approval-id']!
    d.holds.resolve(runId, 'rejected')
    expect(handleAuthzWithHold(rpc('pay'), {}, d).status).toBe(403)
  })

  it('an argument of the wrong type fails closed with 403', () => {
    const d = deps(NO_RULES, '@id("small") permit (principal, action, resource) unless { context.input has amount && context.input.amount > 100 };')
    expect(handleAuthzWithHold(rpc('pay', { amount: 50 }), {}, d).status).toBe(200)
    expect(handleAuthzWithHold(rpc('pay', { amount: '5000' }), {}, d).status).toBe(403)
  })

  it('ignores a caller-supplied principal header unless the operator names one', () => {
    const POL = 'permit (principal == JamJet::Agent::"admin", action, resource);'
    const off = deps(NO_RULES, POL)
    expect(handleAuthzWithHold(rpc('search'), { 'x-jamjet-agent': 'admin' }, off).status).toBe(403)
    const on = deps(NO_RULES, POL, { principalHeader: 'x-jamjet-agent' })
    expect(handleAuthzWithHold(rpc('search'), { 'x-jamjet-agent': 'admin' }, on).status).toBe(200)
  })

  it('without Cedar the YAML default allow is unchanged', () => {
    expect(handleAuthzWithHold(rpc('anything'), {}, deps(NO_RULES, null)).status).toBe(200)
  })
})

describe('buildCedar', () => {
  it('throws CedarLoadError on a policy that fails schema validation', () => {
    expect(() => deps(NO_RULES, 'permit (principal, action, resource) when { context.input.nope == 1 };')).toThrow(CedarLoadError)
  })
})

describe('AuthZen with Cedar (AgentCore refund port)', () => {
  const REFUND = `
@id("refund-under-500")
permit (principal is JamJet::Agent, action == JamJet::Action::"call_tool", resource == JamJet::Tool::"RefundTool___process_refund")
when { principal.hasTag("username") && principal.getTag("username") == "refund-agent" && context.input has amount && context.input.amount < 500 };
`
  const agent = { type: 'agent', id: 'user-123', properties: { username: 'refund-agent' } }

  it('subject properties become principal tags', () => {
    const d = deps(NO_RULES, REFUND)
    expect(zen(d, 'process_refund', { subject: agent, args: { amount: 450 } }).decision).toBe(true)
    expect(zen(d, 'process_refund', { subject: agent, args: { amount: 600 } }).decision).toBe(false)
    expect(zen(d, 'process_refund', { subject: { ...agent, properties: { username: 'other' } }, args: { amount: 1 } }).decision).toBe(false)
  })

  it('a deny carries the Cedar reason in context.reason', () => {
    const r = zen(deps(NO_RULES, REFUND), 'process_refund', { subject: agent, args: { amount: 600 } })
    expect(String(r.context.reason)).toMatch(/default deny/)
  })

  it('a request cannot set approval_status through the AuthZen context', () => {
    const d = deps(NO_RULES, 'permit (principal, action, resource) when { context.approval_status == "approved" };')
    expect(zen(d, 'process_refund', { subject: agent, context: { approval_status: 'approved' } }).decision).toBe(false)
  })

  it('risk comes from the AuthZen request context', () => {
    const d = deps(NO_RULES, 'permit (principal, action, resource) when { context.risk == "low" };')
    expect(zen(d, 'x', { context: { risk: 'low' } }).decision).toBe(true)
    expect(zen(d, 'x', { context: { risk: 'high' } }).decision).toBe(false)
    expect(zen(d, 'x').decision).toBe(false)
  })

  it('AuthZen approval_status reflects the hold and is single-use', () => {
    const d = deps(
      NO_RULES,
      `@id("ok") permit (principal, action, resource) when { context.approval_status == "approved" };
@id("ask") @require_approval permit (principal, action, resource) when { context.approval_status != "approved" };`,
    )
    const first = zen(d, 'pay')
    expect(first.decision).toBe(false)
    d.holds.resolve(first.context.jamjet.approval_id, 'approved')
    expect(zen(d, 'pay').decision).toBe(true)
    // Permitted by the policy that reads approval_status, not by the hold fallback.
    expect(lastReceipt(d).policy.matched_pattern).toBe('cedar:ok')
    expect(zen(d, 'pay').decision).toBe(false)
  })

  it('an approval granted to one subject does not release the same call for another', () => {
    const d = deps(NO_RULES, '@require_approval permit (principal, action, resource);')
    const alice = { type: 'agent', id: 'alice' }
    const first = zen(d, 'pay', { subject: alice, args: { amount: 1 } })
    expect(first.decision).toBe(false)
    d.holds.resolve(first.context.jamjet.approval_id, 'approved')
    const bob = zen(d, 'pay', { subject: { type: 'agent', id: 'bob' }, args: { amount: 1 } })
    expect(bob.decision).toBe(false)
    expect(bob.context.jamjet.approval_id).not.toBe(first.context.jamjet.approval_id)
    expect(zen(d, 'pay', { subject: alice, args: { amount: 1 } }).decision).toBe(true)
  })
})
