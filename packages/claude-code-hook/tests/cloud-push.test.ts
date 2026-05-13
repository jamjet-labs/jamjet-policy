import { describe, it, expect, afterEach } from 'vitest'
import {
  redactArgs,
  resolveArgsRedaction,
  traceIdFromEnv,
} from '../src/cloud-push.js'

const VALID_TID = '0af7651916cd43dd8448eb211c80319c'

describe('resolveArgsRedaction', () => {
  const saved = process.env.JAMJET_ARGS_REDACTION
  afterEach(() => {
    if (saved === undefined) delete process.env.JAMJET_ARGS_REDACTION
    else process.env.JAMJET_ARGS_REDACTION = saved
  })

  it('explicit value wins', () => {
    expect(resolveArgsRedaction('none')).toBe('none')
  })

  it('reads env when no explicit value', () => {
    process.env.JAMJET_ARGS_REDACTION = 'hash'
    expect(resolveArgsRedaction()).toBe('hash')
  })

  it('defaults to "full"', () => {
    delete process.env.JAMJET_ARGS_REDACTION
    expect(resolveArgsRedaction()).toBe('full')
  })

  it('unknown env value falls back to "full"', () => {
    process.env.JAMJET_ARGS_REDACTION = 'xyz'
    expect(resolveArgsRedaction()).toBe('full')
  })
})

describe('redactArgs', () => {
  it('full strips content (default R9 behavior)', () => {
    const r = redactArgs({ path: '/etc/passwd' }, 'full')
    expect(r.args).toEqual({ redacted: true })
    expect(r.args_redaction).toBe('full')
  })

  it('hash returns stable sha256 regardless of key order', () => {
    const a = redactArgs({ a: 1, b: 2 }, 'hash')
    const b = redactArgs({ b: 2, a: 1 }, 'hash')
    expect(a.args.sha256).toBe(b.args.sha256)
    expect((a.args.sha256 as string).length).toBe(64)
  })

  it('none passes args through verbatim', () => {
    const orig = { path: '/etc/passwd', mode: 0o600 }
    const r = redactArgs(orig, 'none')
    expect(r.args).toEqual(orig)
    expect(r.args_redaction).toBe('none')
  })
})

describe('traceIdFromEnv', () => {
  const saved = process.env.OTEL_TRACE_ID
  afterEach(() => {
    if (saved === undefined) delete process.env.OTEL_TRACE_ID
    else process.env.OTEL_TRACE_ID = saved
  })

  it('reads OTEL_TRACE_ID when set', () => {
    process.env.OTEL_TRACE_ID = VALID_TID
    expect(traceIdFromEnv()).toBe(VALID_TID)
  })

  it('returns undefined when unset', () => {
    delete process.env.OTEL_TRACE_ID
    expect(traceIdFromEnv()).toBeUndefined()
  })

  it('returns undefined for malformed env value', () => {
    process.env.OTEL_TRACE_ID = 'too-short'
    expect(traceIdFromEnv()).toBeUndefined()
  })
})
