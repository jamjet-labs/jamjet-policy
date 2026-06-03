import { describe, it, expect } from 'vitest'
import { MCP_THREAT_VERSION } from '../src/index.js'

describe('package', () => {
  it('exports a version', () => {
    expect(MCP_THREAT_VERSION).toBe('0.1.0')
  })
})
