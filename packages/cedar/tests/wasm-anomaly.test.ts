import { describe, it, expect, vi } from 'vitest'

// Simulate a Cedar answer that real Cedar never produces: allow with no determining
// policy. JamJet must not authorize a decision it cannot explain.
vi.mock('@cedar-policy/cedar-wasm/nodejs', async (orig) => {
  const real = await orig<typeof import('@cedar-policy/cedar-wasm/nodejs')>()
  return {
    ...real,
    statefulIsAuthorized: () => ({
      type: 'success',
      response: { decision: 'allow', diagnostics: { reason: [], errors: [] } },
      warnings: [],
    }),
  }
})

describe('anomalous Cedar answers', () => {
  it('blocks an allow that has no determining policy', async () => {
    const { loadCedarPolicies } = await import('../src/index.js')
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);' })
    const d = set.evaluate({ server: 's', tool: 't', args: {} })
    expect(d.policyKind).toBe('block')
    expect(d.pattern).toBe('cedar:error')
  })
})
