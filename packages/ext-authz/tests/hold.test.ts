import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHoldStore } from '../src/hold.js'
import type { AuthzAction } from '../src/types.js'

const action: AuthzAction = { server: 'mcp', tool: 'payments.transfer', args: { amt: 100 } }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'extauthz-hold-')) })

describe('createHoldStore', () => {
  it('creates a pending hold and finds it again by action', () => {
    const store = createHoldStore(dir)
    const rec = store.hold(action, '2026-06-24T00:00:00.000Z')
    expect(rec.status).toBe('pending')
    expect(store.find(action)?.run_id).toBe(rec.run_id)
  })
  it('returns the same runId for a repeated identical action', () => {
    const store = createHoldStore(dir)
    const a = store.hold(action, 'now')
    const b = store.hold(action, 'now')
    expect(a.run_id).toBe(b.run_id)
  })
  it('resolves to approved and peeks the new status', () => {
    const store = createHoldStore(dir)
    const rec = store.hold(action, 'now')
    expect(store.resolve(rec.run_id, 'approved')).toBe(true)
    expect(store.peek(rec.run_id)).toBe('approved')
  })
  it('peeks unknown for an unseen runId', () => {
    expect(createHoldStore(dir).peek('run_nope')).toBe('unknown')
  })
  it('resolve returns false for a missing runId', () => {
    expect(createHoldStore(dir).resolve('run_nope', 'approved')).toBe(false)
  })
})
