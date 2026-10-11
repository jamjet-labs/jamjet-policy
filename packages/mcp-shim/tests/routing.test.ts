import { describe, it, expect } from 'vitest'
import { resolveRequestIdentity, decodeHeaderValue, HEADER_MISMATCH } from '../src/routing.js'

const call = (name: unknown, extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name, arguments: {}, ...extra },
})
const modernMeta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }

describe('resolveRequestIdentity (body only, stdio)', () => {
  it('takes method and tool name from the body', () => {
    const r = resolveRequestIdentity(call('read_file'))
    expect(r).toEqual({ ok: true, identity: { method: 'tools/call', name: 'read_file' } })
  })

  it('takes the uri as the name for resources/read', () => {
    const r = resolveRequestIdentity({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///a' } })
    expect(r).toEqual({ ok: true, identity: { method: 'resources/read', name: 'file:///a' } })
  })

  it('has no name for methods that carry none', () => {
    const r = resolveRequestIdentity({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r).toEqual({ ok: true, identity: { method: 'tools/list', name: null } })
  })

  it('refuses a JSON-RPC batch (array) instead of passing it through ungoverned', () => {
    const r = resolveRequestIdentity([call('database.delete_all')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(-32600)
  })

  it('refuses a message without a string method', () => {
    const r = resolveRequestIdentity({ jsonrpc: '2.0', id: 1, method: 7 })
    expect(r.ok).toBe(false)
  })

  it('refuses a tools/call whose name is not a string', () => {
    for (const bad of [undefined, null, 42, ['rm'], { toString: 'rm' }]) {
      const r = resolveRequestIdentity(call(bad))
      expect(r.ok, `name=${JSON.stringify(bad)}`).toBe(false)
      if (!r.ok) expect(r.code).toBe(-32602)
    }
  })

  it('accepts an empty-string name only as a string (policy sees exactly what the server sees)', () => {
    const r = resolveRequestIdentity(call(''))
    expect(r).toEqual({ ok: true, identity: { method: 'tools/call', name: '' } })
  })
})

describe('resolveRequestIdentity (with HTTP headers)', () => {
  it('accepts headers that match the body, case-insensitively by header name', () => {
    const r = resolveRequestIdentity(call('get_weather', modernMeta), {
      'mcp-method': 'tools/call', 'MCP-NAME': 'get_weather', 'Mcp-Protocol-Version': '2026-07-28',
    })
    expect(r).toEqual({ ok: true, identity: { method: 'tools/call', name: 'get_weather' } })
  })

  it('refuses an Mcp-Name that differs from the body name (header smuggling)', () => {
    const r = resolveRequestIdentity(call('database.delete_all', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'database.read', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(HEADER_MISMATCH)
      expect(r.message).toMatch(/Mcp-Name/)
    }
  })

  it('refuses an Mcp-Method that differs from the body method', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), {
      'Mcp-Method': 'tools/list', 'Mcp-Name': 'x', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(HEADER_MISMATCH)
  })

  it('header values are case-sensitive', () => {
    const r = resolveRequestIdentity(call('Read', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'read', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
  })

  it('decodes a base64 sentinel Mcp-Name before comparing', () => {
    const name = 'wetter_f\u00FCr_heute'
    const enc = `=?base64?${Buffer.from(name, 'utf-8').toString('base64')}?=`
    const ok = resolveRequestIdentity(call(name, modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': enc, 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(ok.ok).toBe(true)
    const bad = resolveRequestIdentity(call('other', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': enc, 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(bad.ok).toBe(false)
  })

  it('refuses a missing Mcp-Name on a modern tools/call', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), { 'Mcp-Method': 'tools/call', 'MCP-Protocol-Version': '2026-07-28' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(HEADER_MISMATCH)
  })

  it('refuses a missing Mcp-Method on a modern request', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), { 'Mcp-Name': 'x', 'MCP-Protocol-Version': '2026-07-28' })
    expect(r.ok).toBe(false)
  })

  it('refuses an MCP-Protocol-Version header that differs from the body _meta version', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'x', 'MCP-Protocol-Version': '2025-11-25',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(HEADER_MISMATCH)
  })

  it('refuses a repeated (multi-valued) routing header', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': ['x', 'y'], 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/more than once/)
  })

  it('refuses the same routing header sent twice under different casing', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'x', 'mcp-name': 'database.delete_all', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
  })

  it('refuses an Mcp-Name sent for a method that has no name', () => {
    const r = resolveRequestIdentity({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernMeta }, {
      'Mcp-Method': 'tools/list', 'Mcp-Name': 'x', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/not valid for method 'tools\/list'/)
  })

  it('refuses a raw control character in a header even when it equals the body', () => {
    const r = resolveRequestIdentity(call('a\u0001b', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'a\u0001b', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/invalid characters/)
  })

  it('refuses a header value with control characters', () => {
    const r = resolveRequestIdentity(call('x', modernMeta), {
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'x\r\nMcp-Name: y', 'MCP-Protocol-Version': '2026-07-28',
    })
    expect(r.ok).toBe(false)
  })

  it('still validates headers that a legacy request chose to send', () => {
    const r = resolveRequestIdentity(call('database.delete_all'), { 'Mcp-Name': 'database.read' })
    expect(r.ok).toBe(false)
  })

  it('accepts a legacy request without routing headers', () => {
    const r = resolveRequestIdentity(call('x'), { 'Content-Type': 'application/json' })
    expect(r.ok).toBe(true)
  })
})

describe('decodeHeaderValue', () => {
  it('returns plain values unchanged', () => {
    expect(decodeHeaderValue('us-west1')).toBe('us-west1')
  })
  it('decodes the sentinel', () => {
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, \u4E16\u754C')
  })
  it('returns null for malformed base64 in the sentinel', () => {
    expect(decodeHeaderValue('=?base64?not base64!?=')).toBeNull()
  })
  it('the sentinel markers are case-sensitive', () => {
    expect(decodeHeaderValue('=?BASE64?SGk=?=')).toBe('=?BASE64?SGk=?=')
  })
})
