import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvaluator } from '../src/policy.js'
import { handleAuthz, type AuthzDeps } from '../src/handle.js'
import { mkdtempSync as mkdtempSync2 } from 'node:fs'
import { createHoldStore } from '../src/hold.js'
import { handleAuthzWithHold, type AuthzDepsV2 } from '../src/handle.js'

function rpc(tool: string) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } })
}

let deps: AuthzDeps
let auditPath: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-handle-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n', 'utf-8')
  auditPath = join(dir, 'receipts.jsonl')
  deps = { evaluator: buildEvaluator(policyPath), auditPath, now: () => '2026-06-24T00:00:00.000Z', defaultServer: 'mcp' }
})

describe('handleAuthz', () => {
  it('returns 200 and a receipt header for an allowed tool', () => {
    const res = handleAuthz(rpc('search'), {}, deps)
    expect(res.status).toBe(200)
    expect(res.headers['x-jamjet-receipt']).toMatch(/^sha256:/)
  })
  it('returns 403 for a blocked tool and writes a receipt', () => {
    const res = handleAuthz(rpc('delete_user'), {}, deps)
    expect(res.status).toBe(403)
    expect(existsSync(auditPath)).toBe(true)
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n')
    expect(lines.some((l) => l.includes('"decision":"BLOCKED"'))).toBe(true)
  })
  it('passes through non tools/call requests with 200', () => {
    const res = handleAuthz(JSON.stringify({ method: 'tools/list' }), {}, deps)
    expect(res.status).toBe(200)
  })
})

describe('handleAuthzWithHold (approval bridge)', () => {
  function rpc2(tool: string) {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { amt: 1 } } })
  }
  function freshDeps(): AuthzDepsV2 {
    const dir = mkdtempSync2(join(tmpdir(), 'extauthz-bridge-'))
    const policyPath = join(dir, 'policy.yaml')
    writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "payments.*"\n    action: require_approval\n', 'utf-8')
    return {
      evaluator: buildEvaluator(policyPath),
      auditPath: join(dir, 'r.jsonl'),
      now: () => '2026-06-24T00:00:00.000Z',
      defaultServer: 'mcp',
      holds: createHoldStore(join(dir, 'holds')),
      approvalBaseUrl: 'http://localhost:9191/approve',
    }
  }

  it('first call to a held tool returns 403 step-up with an approval id', () => {
    const res = handleAuthzWithHold(rpc2('payments.transfer'), {}, freshDeps())
    expect(res.status).toBe(403)
    expect(res.headers['www-authenticate']).toContain('insufficient_scope')
    expect(res.headers['x-jamjet-approval-id']).toMatch(/^run_/)
  })

  it('after approval, a retry of the same call returns 200', () => {
    const deps = freshDeps()
    const first = handleAuthzWithHold(rpc2('payments.transfer'), {}, deps)
    const runId = first.headers['x-jamjet-approval-id']!
    expect(deps.holds.resolve(runId, 'approved')).toBe(true)
    const retry = handleAuthzWithHold(rpc2('payments.transfer'), {}, deps)
    expect(retry.status).toBe(200)
  })

  it('after rejection, a retry returns 403', () => {
    const deps = freshDeps()
    const first = handleAuthzWithHold(rpc2('payments.transfer'), {}, deps)
    deps.holds.resolve(first.headers['x-jamjet-approval-id']!, 'rejected')
    const retry = handleAuthzWithHold(rpc2('payments.transfer'), {}, deps)
    expect(retry.status).toBe(403)
  })
})
