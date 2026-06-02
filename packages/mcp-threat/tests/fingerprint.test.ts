import { describe, it, expect } from 'vitest'
import { canonicalize, sha256Canonical, hashToolDefinition } from '../src/fingerprint.js'

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }))
  })
  it('distinguishes different values', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }))
  })
})

describe('sha256Canonical', () => {
  it('returns a prefixed hex digest, stable across key order', () => {
    const h1 = sha256Canonical({ x: 1, y: [1, 2] })
    const h2 = sha256Canonical({ y: [1, 2], x: 1 })
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(h1).toBe(h2)
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
