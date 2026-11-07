import { describe, it, expect } from 'vitest'
import { globMatch } from '../src/glob.js'

describe('globMatch', () => {
  it.each([
    ['*', '', true],
    ['*', 'anything', true],
    ['Bash', 'Bash', true],
    ['Bash', 'bash', false],
    ['Bash', 'BashX', false],
    ['*delete*', 'mcp__pg__delete_rows', true],
    ['*delete*', 'mcp__pg__drop', false],
    ['mcp__*__query', 'mcp__pg__query', true],
    ['mcp__*__query', 'mcp__pg__query2', false],
    ['W?b*', 'WebFetch', true],
    ['?', '', false],
    ['a*b*c', 'aXbYc', true],
    ['a*b*c', 'aXbY', false],
    ['**', 'x', true],
  ])('%j vs %j -> %s', (pattern, name, expected) => {
    expect(globMatch(pattern, name)).toBe(expected)
  })

  it('* and ? match newlines', () => {
    expect(globMatch('*', 'a\nb')).toBe(true)
    expect(globMatch('a?b', 'a\nb')).toBe(true)
  })

  it('stays fast on patterns that make a regex backtrack', () => {
    const pattern = 'a*'.repeat(12) + 'b'
    const name = 'a'.repeat(120)
    const started = Date.now()
    expect(globMatch(pattern, name)).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
  })
})
