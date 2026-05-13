import { describe, expect, it } from 'vitest'
import { applyRedaction } from '../src/sync/redaction.js'
import type { AuditEventV1 } from '../src/types.js'

const baseEvent: AuditEventV1 = {
  ts: '2026-05-12T00:00:00Z',
  run_id: 'run_a',
  adapter: 'openai-guardrail',
  host: 'openai-agents-sdk',
  tool: 'db.lookup_user',
  decision: 'BLOCKED',
  executed: false,
  schema_version: 1,
  args: { user_id: 'u_4821', email: 'alice@example.com' },
}

describe('applyRedaction', () => {
  it('mode=full strips args entirely', () => {
    const r = applyRedaction(baseEvent, 'full')
    expect(r.args).toEqual({ redacted: true })
    expect(r.args_redaction).toBe('full')
  })

  it('mode=hash replaces args with a stable sha256', () => {
    const r = applyRedaction(baseEvent, 'hash')
    expect(r.args.redacted).toBe(true)
    expect(typeof r.args.sha256).toBe('string')
    expect(r.args.sha256 as string).toMatch(/^[a-f0-9]{64}$/)
    expect(r.args_redaction).toBe('hash')

    // Same input → same hash (deterministic).
    const r2 = applyRedaction(baseEvent, 'hash')
    expect(r2.args.sha256).toBe(r.args.sha256)
  })

  it('mode=none passes args through unchanged', () => {
    const r = applyRedaction(baseEvent, 'none')
    expect(r.args).toEqual({ user_id: 'u_4821', email: 'alice@example.com' })
    expect(r.args_redaction).toBe('none')
  })

  it('mode=full is idempotent on already-redacted events', () => {
    const already: AuditEventV1 = { ...baseEvent, args: { redacted: true } }
    const r = applyRedaction(already, 'full')
    expect(r.args).toEqual({ redacted: true })
  })

  it('hash is stable across object key order', () => {
    const a: AuditEventV1 = { ...baseEvent, args: { x: 1, y: 2 } }
    const b: AuditEventV1 = { ...baseEvent, args: { y: 2, x: 1 } }
    expect((applyRedaction(a, 'hash').args.sha256 as string)).toBe(
      applyRedaction(b, 'hash').args.sha256 as string,
    )
  })

  it('hash is stable across nested object key order', () => {
    const a: AuditEventV1 = {
      ...baseEvent,
      args: { outer: { x: 1, y: 2 }, list: [{ a: 1, b: 2 }] },
    }
    const b: AuditEventV1 = {
      ...baseEvent,
      args: { list: [{ b: 2, a: 1 }], outer: { y: 2, x: 1 } },
    }
    expect((applyRedaction(a, 'hash').args.sha256 as string)).toBe(
      applyRedaction(b, 'hash').args.sha256 as string,
    )
  })
})
