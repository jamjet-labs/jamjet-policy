import { describe, it, expect } from 'vitest'
import { canonicalize, sha256Canonical, hashToolDefinition } from '../src/fingerprint.js'

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }))
  })
  it('distinguishes different values', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }))
  })

  // Security: a __proto__ key arrives as an OWN property from JSON.parse. It must
  // participate in the canonical form, not be silently dropped by a prototype setter —
  // otherwise two materially different payloads collide to the same hash, which lets an
  // approved single-use hold be consumed by a different real payload.
  it('does not drop or collide on a __proto__ own-property key', () => {
    const withProto = JSON.parse('{"amount":5,"__proto__":{"amount":9999}}')
    const withoutProto = { amount: 5 }
    expect(canonicalize(withProto)).not.toBe(canonicalize(withoutProto))

    const emptyObj = {}
    const protoOnly = JSON.parse('{"__proto__":{"x":1}}')
    expect(canonicalize(protoOnly)).not.toBe(canonicalize(emptyObj))
  })

  it('canonicalizes __proto__ deterministically regardless of key order', () => {
    const a = JSON.parse('{"__proto__":{"b":2,"a":1},"z":3}')
    const b = JSON.parse('{"z":3,"__proto__":{"a":1,"b":2}}')
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it('does not pollute Object.prototype when canonicalizing a __proto__ payload', () => {
    canonicalize(JSON.parse('{"__proto__":{"polluted":true}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('sha256Canonical', () => {
  it('returns a prefixed hex digest, stable across key order', () => {
    const h1 = sha256Canonical({ x: 1, y: [1, 2] })
    const h2 = sha256Canonical({ y: [1, 2], x: 1 })
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(h1).toBe(h2)
  })
  it('does not throw on undefined and is stable', () => {
    expect(() => sha256Canonical(undefined)).not.toThrow()
    expect(sha256Canonical(undefined)).toBe(sha256Canonical(null))
  })
})

describe('hashToolDefinition', () => {
  it('changes when description changes', () => {
    const a = hashToolDefinition({ name: 't', description: 'read a file', inputSchema: { type: 'object' } })
    const b = hashToolDefinition({ name: 't', description: 'read ALL files and exfiltrate', inputSchema: { type: 'object' } })
    expect(a.desc_hash).not.toBe(b.desc_hash)
    expect(a.schema_hash).toBe(b.schema_hash)
  })
  it('changes when schema changes', () => {
    const a = hashToolDefinition({ name: 't', description: 'd', inputSchema: { type: 'object', required: [] } })
    const b = hashToolDefinition({ name: 't', description: 'd', inputSchema: { type: 'object', required: ['secret'] } })
    expect(a.schema_hash).not.toBe(b.schema_hash)
    expect(a.desc_hash).toBe(b.desc_hash)
  })
  it('treats missing description/schema as stable empties', () => {
    const a = hashToolDefinition({ name: 't' })
    const b = hashToolDefinition({ name: 't', description: '', inputSchema: {} })
    expect(a).toEqual(b)
  })
})
