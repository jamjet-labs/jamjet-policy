import { describe, it, expect } from 'vitest'
import {
  bootstrapPolicy,
  DEMO_POLICY,
  DEMO_POLICY_WARNING,
} from '../src/bootstrap-policy.js'
import type { Policy } from '@jamjet/cloud'

const realPolicy: Policy = {
  version: 1,
  rules: [{ match: 'foo.*', action: 'block' }],
}

describe('bootstrapPolicy', () => {
  it('returns the loaded policy when loadPolicy succeeds', () => {
    const result = bootstrapPolicy(
      { policyPath: '/some/policy.yaml' },
      { loadPolicy: () => realPolicy },
    )
    expect(result.source).toBe('file')
    expect(result.policy).toBe(realPolicy)
    expect(result.policyPath).toBe('/some/policy.yaml')
    expect(result.warning).toBeNull()
  })

  it('falls back to DEMO_POLICY when loadPolicy throws "No policy file found"', () => {
    const result = bootstrapPolicy(
      {},
      {
        loadPolicy: () => {
          throw new Error('No policy file found. Set JAMJET_POLICY_FILE, or place policy.yaml in cwd or ~/.jamjet/')
        },
      },
    )
    expect(result.source).toBe('demo')
    expect(result.policy).toBe(DEMO_POLICY)
    expect(result.policyPath).toBe('(built-in demo policy)')
    expect(result.warning).toBe(DEMO_POLICY_WARNING)
  })

  it('rethrows any error that is not the "no policy" sentinel', () => {
    expect(() =>
      bootstrapPolicy(
        { policyPath: '/some/policy.yaml' },
        {
          loadPolicy: () => {
            throw new Error('YAMLParseError: All sequence items must start at the same column')
          },
        },
      ),
    ).toThrow(/YAMLParseError/)
  })

  it('DEMO_POLICY is a valid Policy v1 with at least one block rule', () => {
    expect(DEMO_POLICY.version).toBe(1)
    expect(DEMO_POLICY.rules.length).toBeGreaterThan(0)
    expect(DEMO_POLICY.rules.some((r) => r.action === 'block')).toBe(true)
    for (const r of DEMO_POLICY.rules) {
      expect(typeof r.match).toBe('string')
      expect(['allow', 'block', 'require_approval', 'audit']).toContain(r.action)
    }
  })

  it('DEMO_POLICY_WARNING tells the user how to bind real rules', () => {
    expect(DEMO_POLICY_WARNING).toMatch(/--policy/)
    expect(DEMO_POLICY_WARNING).toMatch(/demo/i)
  })
})
