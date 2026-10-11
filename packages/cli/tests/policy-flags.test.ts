import { describe, it, expect } from 'vitest'
import { missingFlagValue } from '../src/policy/commands.js'

describe('copilot: value flags must have values', () => {
  it('flags a value flag followed by another flag or nothing', () => {
    expect(missingFlagValue(['--tool', '--cedar', 'p.cedar'])).toBe('--tool')
    expect(missingFlagValue(['--cedar', '--policy', 'p.yaml'])).toBe('--cedar')
    expect(missingFlagValue(['--policy', 'p.yaml', '--cedar'])).toBe('--cedar')
    expect(missingFlagValue(['--cedar', 'a.cedar', '--cedar'])).toBe('--cedar')
  })
  it('accepts well-formed flags (control)', () => {
    expect(missingFlagValue(['--tool', 't', '--cedar', 'p.cedar', '--json'])).toBeNull()
    expect(missingFlagValue(['--args', '{"a":1}', '--tag', 'k=v'])).toBeNull()
  })
})
