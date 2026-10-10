import { describe, it, expect } from 'vitest'
import {
  classifyClientRequestVersion,
  checkInitializeResult,
  filterDiscoverResult,
  unsupportedVersionError,
  KNOWN_VERSIONS,
  MODERN_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
} from '../src/protocol.js'

const modern = (v: unknown, method = 'tools/call') => ({
  jsonrpc: '2.0', id: 1, method,
  params: { name: 'x', _meta: { 'io.modelcontextprotocol/protocolVersion': v } },
})

describe('classifyClientRequestVersion', () => {
  it('reads the modern per-request version from params._meta', () => {
    expect(classifyClientRequestVersion(modern('2026-07-28'))).toEqual({ kind: 'known', version: '2026-07-28', era: 'modern' })
  })

  it('reads the legacy version from initialize params.protocolVersion', () => {
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }
    expect(classifyClientRequestVersion(init)).toEqual({ kind: 'known', version: '2025-06-18', era: 'legacy' })
  })

  it('reports an unknown modern version', () => {
    expect(classifyClientRequestVersion(modern('2027-01-01'))).toEqual({ kind: 'unknown', version: '2027-01-01' })
  })

  it('reports a non-string version as unknown, not as absent', () => {
    expect(classifyClientRequestVersion(modern(20260728))).toEqual({ kind: 'unknown', version: 20260728 })
  })

  it('reports an unknown initialize version', () => {
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2030-01-01' } }
    expect(classifyClientRequestVersion(init).kind).toBe('unknown')
  })

  it('treats a legacy version carried in modern _meta as unknown (no handshake era to serve it)', () => {
    expect(classifyClientRequestVersion(modern('2025-11-25')).kind).toBe('unknown')
  })

  it('returns none for a request without any version (legacy post-initialize traffic)', () => {
    expect(classifyClientRequestVersion({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toEqual({ kind: 'none' })
  })
})

describe('unsupportedVersionError', () => {
  it('builds the spec error shape with -32022 and the supported list', () => {
    const e = unsupportedVersionError(7, '1900-01-01')
    expect(e).toEqual({
      jsonrpc: '2.0', id: 7,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: expect.stringMatching(/Unsupported protocol version/),
        data: { supported: [...KNOWN_VERSIONS], requested: '1900-01-01' },
      },
    })
    expect(UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022)
  })
})

describe('checkInitializeResult', () => {
  it('accepts a known negotiated legacy version', () => {
    expect(checkInitializeResult({ protocolVersion: '2025-03-26' })).toEqual({ ok: true })
  })
  it('refuses an unknown negotiated version', () => {
    expect(checkInitializeResult({ protocolVersion: '2031-02-02' })).toEqual({ ok: false, version: '2031-02-02' })
  })
  it('refuses a modern version negotiated through the legacy handshake', () => {
    expect(checkInitializeResult({ protocolVersion: '2026-07-28' }).ok).toBe(false)
  })
  it('refuses a missing version', () => {
    expect(checkInitializeResult({}).ok).toBe(false)
  })
})

describe('filterDiscoverResult', () => {
  it('keeps only versions the shim understands and reports what it removed', () => {
    const r = filterDiscoverResult({ resultType: 'complete', supportedVersions: ['2027-03-01', '2026-07-28', '2025-11-25'], capabilities: {} })
    expect(r.result.supportedVersions).toEqual(['2026-07-28', '2025-11-25'])
    expect(r.removed).toEqual(['2027-03-01'])
    expect(r.result.capabilities).toEqual({})
  })
  it('reports an empty intersection', () => {
    const r = filterDiscoverResult({ supportedVersions: ['2027-03-01'] })
    expect(r.result.supportedVersions).toEqual([])
    expect(r.removed).toEqual(['2027-03-01'])
  })
  it('drops non-string entries', () => {
    const r = filterDiscoverResult({ supportedVersions: [42, '2026-07-28'] })
    expect(r.result.supportedVersions).toEqual(['2026-07-28'])
    expect(r.removed).toEqual([42])
  })
  it('the modern list contains 2026-07-28', () => {
    expect(MODERN_VERSIONS).toContain('2026-07-28')
  })
})
