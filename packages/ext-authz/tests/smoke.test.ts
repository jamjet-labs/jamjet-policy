import { describe, it, expect } from 'vitest'
import type { AuthzAction } from '../src/types.js'

describe('package scaffold', () => {
  it('constructs an AuthzAction shape', () => {
    const a: AuthzAction = { server: 'mcp', tool: 'search', args: {} }
    expect(a.tool).toBe('search')
  })
})
