import { describe, it, expect, vi } from 'vitest'
import { loadCedarPolicies } from '../src/index.js'

const AMOUNT_INPUT = 'namespace JamJet::Input { type Line = { sku: String }; type ToolInput = { amount?: Long, lines?: Set<Line>, meta?: { ok: Bool } }; }'

describe('review: preparse keys are unique across module instances', () => {
  it('a second copy of the module does not overwrite the first copy\'s policies', async () => {
    const a = loadCedarPolicies({ policies: 'permit (principal, action, resource);\nforbid (principal, action, resource) when { resource.name == "delete_db" };' })
    expect(a.evaluate({ server: 's', tool: 'delete_db', args: {} }).policyKind).toBe('block')
    vi.resetModules()
    const copy = await import('../src/index.js')
    copy.loadCedarPolicies({ policies: 'permit (principal, action, resource);' })
    expect(a.evaluate({ server: 's', tool: 'delete_db', args: {} }).policyKind).toBe('block')
  })
})

describe('review: approval annotation near-misses are rejected', () => {
  for (const ann of ['@requires_approval', '@approval', '@Require_Approval', '@require_approvals', '@needs_approval("true")']) {
    it(`rejects ${ann}`, () => {
      expect(() => loadCedarPolicies({ policies: `${ann} permit (principal, action, resource);` })).toThrow(/approv/i)
    })
  }
  it('still accepts unrelated annotations', () => {
    expect(loadCedarPolicies({ policies: '@description("x") permit (principal, action, resource);' }).policyIds).toEqual(['policy0'])
  })
})

describe('review: has on an undeclared argument is rejected at load', () => {
  it('rejects a mixed has on an argument the input schema does not declare', () => {
    const p = 'forbid (principal, action, resource) when { context.input has override || context.risk == "high" };\npermit (principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: p, inputSchema: AMOUNT_INPUT })).toThrow(/override/)
  })
  it('rejects the path form `context has input.override`', () => {
    const p = 'forbid (principal, action, resource) when { context has input.override || context.risk == "high" };\npermit (principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: p, inputSchema: AMOUNT_INPUT })).toThrow(/override/)
  })
  it('rejects a nested has on an undeclared record attribute', () => {
    const p = 'forbid (principal, action, resource) when { context.input has meta && (context.input.meta has admin || context.risk == "x") };\npermit (principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: p, inputSchema: AMOUNT_INPUT })).toThrow(/admin/)
  })
  it('accepts has on declared arguments (control)', () => {
    const p = 'forbid (principal, action, resource) when { context.input has amount && context.input has meta.ok };\npermit (principal, action, resource);'
    expect(loadCedarPolicies({ policies: p, inputSchema: AMOUNT_INPUT }).policyIds.length).toBe(2)
  })
})

describe('review: integers JavaScript cannot represent exactly fail closed', () => {
  it('blocks an argument beyond Number.MAX_SAFE_INTEGER', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);', inputSchema: AMOUNT_INPUT })
    expect(set.evaluate({ server: 's', tool: 't', args: { amount: 9007199254740993 } }).policyKind).toBe('block')
    expect(set.evaluate({ server: 's', tool: 't', args: { amount: 9007199254740991 } }).policyKind).toBe('allow')
  })
})

describe('copilot: values that are not plain JSON fail closed', () => {
  const set = loadCedarPolicies({
    policies: 'permit (principal, action, resource);\nforbid (principal, action, resource) when { context.input has note && context.input.note == "x" };',
    inputSchema: 'namespace JamJet::Input { type ToolInput = { note?: String, amount?: Long }; }',
  })
  const call = (args: Record<string, unknown>) => set.evaluate({ server: 's', tool: 't', args }).policyKind
  it('an undefined argument blocks instead of being dropped', () => {
    expect(call({ amount: undefined })).toBe('block')
  })
  it('a function argument blocks', () => {
    expect(call({ note: () => 'x' })).toBe('block')
  })
  it('an object with toJSON blocks instead of being coerced', () => {
    expect(call({ note: { toJSON: () => 'y' } })).toBe('block')
    expect(call({ note: new Date(0) })).toBe('block')
  })
  it('a non-JSON tag value blocks', () => {
    const d = set.evaluate({ server: 's', tool: 't', args: {}, principal: { id: 'a', tags: { t: undefined as unknown as string } } })
    expect(d.policyKind).toBe('block')
  })
  it('plain JSON still evaluates (control)', () => {
    expect(call({ note: 'y', amount: 1 })).toBe('allow')
    expect(call({ note: 'x' })).toBe('block')
  })
})

describe('copilot: a declared __proto__ argument is kept', () => {
  it('a forbid on a __proto__ argument fires', () => {
    const set = loadCedarPolicies({
      policies: 'permit (principal, action, resource);\nforbid (principal, action, resource) when { context.input has "__proto__" && context.input["__proto__"] > 1 };',
      inputSchema: 'namespace JamJet::Input { type ToolInput = { "__proto__"?: Long }; }',
    })
    const args = JSON.parse('{"__proto__": 5}') as Record<string, unknown>
    expect(set.evaluate({ server: 's', tool: 't', args }).policyKind).toBe('block')
  })
  it('a __proto__ principal tag is kept', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);\nforbid (principal, action, resource) when { principal.hasTag("__proto__") };' })
    const tags = JSON.parse('{"__proto__": "x"}') as Record<string, string>
    expect(set.evaluate({ server: 's', tool: 't', args: {}, principal: { id: 'a', tags } }).policyKind).toBe('block')
  })
})
