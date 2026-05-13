import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveArgsRedaction,
  redactArgs,
  traceIdFromMcpRequest,
} from '../src/cloud-push.js'

const VALID_TID = '0af7651916cd43dd8448eb211c80319c'

describe('resolveArgsRedaction', () => {
  const savedEnv = process.env.JAMJET_ARGS_REDACTION

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.JAMJET_ARGS_REDACTION
    else process.env.JAMJET_ARGS_REDACTION = savedEnv
  })

  it('returns explicit value when passed', () => {
    expect(resolveArgsRedaction('hash')).toBe('hash')
    expect(resolveArgsRedaction('none')).toBe('none')
  })

  it('reads env when no explicit value', () => {
    process.env.JAMJET_ARGS_REDACTION = 'hash'
    expect(resolveArgsRedaction()).toBe('hash')
  })

  it('falls back to "full" on unset env', () => {
    delete process.env.JAMJET_ARGS_REDACTION
    expect(resolveArgsRedaction()).toBe('full')
  })

  it('falls back to "full" on unknown env value', () => {
    process.env.JAMJET_ARGS_REDACTION = 'bogus'
    expect(resolveArgsRedaction()).toBe('full')
  })
})

describe('redactArgs', () => {
  it('full strips args content', () => {
    const r = redactArgs({ email: 'alice@example.com', amount: 100 }, 'full')
    expect(r.args).toEqual({ redacted: true })
    expect(r.args_redaction).toBe('full')
  })

  it('hash returns redacted + stable sha256', () => {
    const a = redactArgs({ email: 'a@b.com', amount: 100 }, 'hash')
    const b = redactArgs({ amount: 100, email: 'a@b.com' }, 'hash')
    expect(a.args.sha256).toBe(b.args.sha256)
    expect(a.args.redacted).toBe(true)
    expect(typeof a.args.sha256).toBe('string')
    expect((a.args.sha256 as string).length).toBe(64)
  })

  it('none passes args through verbatim', () => {
    const orig = { email: 'a@b.com', amount: 100 }
    const r = redactArgs(orig, 'none')
    expect(r.args).toEqual(orig)
    expect(r.args_redaction).toBe('none')
  })
})

describe('traceIdFromMcpRequest', () => {
  const savedEnv = process.env.OTEL_TRACE_ID

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OTEL_TRACE_ID
    else process.env.OTEL_TRACE_ID = savedEnv
  })

  it('reads _meta.traceparent from MCP params', () => {
    delete process.env.OTEL_TRACE_ID
    const trace = traceIdFromMcpRequest({
      name: 'fs.read',
      arguments: { path: '/etc' },
      _meta: { traceparent: `00-${VALID_TID}-b7ad6b7169203331-01` },
    })
    expect(trace).toBe(VALID_TID)
  })

  it('falls back to OTEL_TRACE_ID env when _meta absent', () => {
    process.env.OTEL_TRACE_ID = VALID_TID
    expect(traceIdFromMcpRequest({ name: 'fs.read', arguments: {} })).toBe(VALID_TID)
  })

  it('returns undefined when no source has a usable trace', () => {
    delete process.env.OTEL_TRACE_ID
    expect(traceIdFromMcpRequest(undefined)).toBeUndefined()
    expect(traceIdFromMcpRequest({})).toBeUndefined()
    expect(traceIdFromMcpRequest({ _meta: {} })).toBeUndefined()
  })

  it('ignores malformed _meta.traceparent', () => {
    delete process.env.OTEL_TRACE_ID
    expect(
      traceIdFromMcpRequest({ _meta: { traceparent: 'garbage' } }),
    ).toBeUndefined()
  })

  it('_meta.traceparent wins over OTEL_TRACE_ID env', () => {
    process.env.OTEL_TRACE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    expect(
      traceIdFromMcpRequest({
        _meta: { traceparent: `00-${VALID_TID}-b7ad6b7169203331-01` },
      }),
    ).toBe(VALID_TID)
  })
})
