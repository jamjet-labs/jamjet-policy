import { describe, it, expect } from 'vitest'
import { buildPolicyReceipt, RECEIPT_VERSION } from '../src/receipt.js'
import type { AuthzAction } from '../src/types.js'

const action: AuthzAction = { server: 'mcp', tool: 'delete_user', args: { id: 7 } }

describe('buildPolicyReceipt', () => {
  it('stamps the version and a sha256 hash', () => {
    const r = buildPolicyReceipt(action, 'BLOCKED', 'delete_*', '2026-06-24T00:00:00.000Z')
    expect(r.version).toBe(RECEIPT_VERSION)
    expect(r.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(r.policy.decision).toBe('BLOCKED')
    expect(r.tool).toBe('delete_user')
  })
  it('is deterministic for identical input', () => {
    const a = buildPolicyReceipt(action, 'BLOCKED', 'delete_*', '2026-06-24T00:00:00.000Z')
    const b = buildPolicyReceipt(action, 'BLOCKED', 'delete_*', '2026-06-24T00:00:00.000Z')
    expect(a.receipt_hash).toBe(b.receipt_hash)
  })
  it('includes an approval block when supplied', () => {
    const r = buildPolicyReceipt(action, 'ALLOWED', 'payments.*', '2026-06-24T00:00:00.000Z', { run_id: 'run_abc', status: 'approved' })
    expect(r.approval).toEqual({ run_id: 'run_abc', status: 'approved' })
  })
})
