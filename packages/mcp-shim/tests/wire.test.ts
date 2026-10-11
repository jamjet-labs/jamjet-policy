import { describe, it, expect } from 'vitest'
import { depthExceeds, caseConfusableKey, idKey, isValidId } from '../src/wire.js'

describe('depthExceeds', () => {
  it('counts object and array nesting', () => {
    expect(depthExceeds({ a: { b: [1] } }, 3)).toBe(false)
    expect(depthExceeds({ a: { b: [{}] } }, 3)).toBe(true)
  })
  it('handles very deep values without overflowing', () => {
    let deep: unknown = []
    for (let i = 0; i < 300_000; i++) deep = [deep]
    expect(depthExceeds(deep, 256)).toBe(true)
  })
  it('scalars are depth zero', () => {
    expect(depthExceeds('x', 0)).toBe(false)
  })
})

describe('caseConfusableKey', () => {
  it('finds two keys equal ignoring case', () => {
    expect(caseConfusableKey({ name: 'a', Name: 'b' }, [])).toBe('Name')
  })
  it('finds a case variant of a known member', () => {
    expect(caseConfusableKey({ Method: 'x' }, ['method'])).toBe('Method')
  })
  it('accepts exact members and unrelated keys', () => {
    expect(caseConfusableKey({ method: 'x', Extra: 1 }, ['method'])).toBeNull()
  })
})

describe('ids', () => {
  it('idKey keeps number and string ids apart', () => {
    expect(idKey(3)).not.toBe(idKey('3'))
  })
  it('isValidId accepts strings and finite numbers only', () => {
    expect([1, 'a', 0].every(isValidId)).toBe(true)
    expect([null, true, {}, [], Number.NaN, Infinity, undefined].some(isValidId)).toBe(false)
  })
})
