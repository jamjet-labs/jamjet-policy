import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PolicyDecision } from '@jamjet/cloud'
import {
  loadCedarPolicies,
  loadCedarPoliciesFromFiles,
  combineDecisions,
  CedarLoadError,
  CORE_SCHEMA,
  DEFAULT_INPUT_SCHEMA,
  type ToolCallRequest,
} from '../src/index.js'

const FIXTURES = join(__dirname, 'fixtures')

const AMOUNT_INPUT = 'namespace JamJet::Input { type ToolInput = { amount?: Long, path?: String }; }'

function call(tool: string, extra: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return { server: 'files', tool, args: {}, ...extra }
}

const PERMIT_READS = `
@id("allow-reads")
permit (principal, action == JamJet::Action::"call_tool", resource)
when { resource.name like "read_*" };
`

describe('loading', () => {
  it('accepts a policy set that validates against the published schema', () => {
    const set = loadCedarPolicies({ policies: PERMIT_READS })
    expect(set.policyIds).toEqual(['allow-reads'])
  })

  it('rejects a policy that fails schema validation (fail closed at load)', () => {
    // context.input has no attributes under the default input schema.
    const bad = 'permit (principal, action, resource) when { context.input.amount < 5 };'
    expect(() => loadCedarPolicies({ policies: bad })).toThrow(CedarLoadError)
  })

  it('rejects a policy that names an entity type the schema does not declare', () => {
    const bad = 'permit (principal is AgentCore::OAuthUser, action, resource);'
    expect(() => loadCedarPolicies({ policies: bad })).toThrow(CedarLoadError)
  })

  it('rejects a policy set that does not parse', () => {
    expect(() => loadCedarPolicies({ policies: 'permit (principal, action' })).toThrow(CedarLoadError)
  })

  it('rejects an input schema that redeclares the JamJet namespace', () => {
    const hostile = 'namespace JamJet { entity Agent; }\nnamespace JamJet::Input { type ToolInput = {}; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: hostile })).toThrow(CedarLoadError)
  })

  it('rejects an input schema that does not declare ToolInput', () => {
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: 'namespace JamJet::Input { type Other = {}; }' })).toThrow(
      CedarLoadError,
    )
  })

  it('rejects an input schema that declares an action (a policy on it would validate but never fire)', () => {
    const s = 'namespace JamJet::Input { type ToolInput = {}; action "RefundTool___process_refund"; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: s })).toThrow(/common types/)
  })

  it('rejects an input schema that declares an entity type', () => {
    const s = 'namespace JamJet::Input { type ToolInput = {}; entity Thing; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: s })).toThrow(/common types/)
  })

  it('rejects an input schema in another namespace', () => {
    const s = 'namespace JamJet::Input { type ToolInput = {}; }\nnamespace Other { type X = {}; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: s })).toThrow(/only declare namespace/)
  })

  it('rejects entity-typed or extension-typed tool arguments', () => {
    const ent = 'namespace JamJet::Input { type ToolInput = { who?: JamJet::Agent }; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: ent })).toThrow(/may only use/)
    const ext = 'namespace JamJet::Input { type ToolInput = { price?: decimal }; }'
    expect(() => loadCedarPolicies({ policies: PERMIT_READS, inputSchema: ext })).toThrow(/may only use/)
  })

  it('accepts nested records, sets and common types in the input schema', () => {
    const s = 'namespace JamJet::Input { type Line = { sku: String, qty: Long }; type ToolInput = { lines?: Set<Line>, meta?: { ok: Bool } }; }'
    const set = loadCedarPolicies({
      policies: 'permit (principal, action, resource) when { context.input has lines && context.input.lines.contains({ sku: "a", qty: 1 }) };',
      inputSchema: s,
    })
    // Undeclared keys inside nested records and set elements are dropped, not rejected.
    const d = set.evaluate(call('order', { args: { lines: [{ sku: 'a', qty: 1, note: 'x' }], meta: { ok: true, extra: 1 } } }))
    expect(d.policyKind).toBe('allow')
  })

  it('rejects a forbid the validator proves can never fire', () => {
    const dead = 'permit (principal, action, resource);\nforbid (principal, action, resource) when { resource.name == "x" && resource.name == "y" && false };'
    expect(() => loadCedarPolicies({ policies: dead })).toThrow(/warning/)
  })

  it('rejects templates (slots are never linked, so they would silently never apply)', () => {
    const tpl = 'permit (principal == ?principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: tpl })).toThrow(/template/i)
  })

  it('rejects duplicate @id annotations', () => {
    const dup = `@id("a") permit (principal, action, resource);\n@id("a") forbid (principal, action, resource);`
    expect(() => loadCedarPolicies({ policies: dup })).toThrow(/duplicate/i)
  })

  it('rejects @require_approval on a forbid policy', () => {
    const bad = '@require_approval forbid (principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: bad })).toThrow(/require_approval/)
  })

  it('rejects @require_approval with a value other than empty or "true"', () => {
    const bad = '@require_approval("false") permit (principal, action, resource);'
    expect(() => loadCedarPolicies({ policies: bad })).toThrow(/require_approval/)
  })

  it('warns when the set has no permit policy (everything will be denied)', () => {
    const set = loadCedarPolicies({ policies: 'forbid (principal, action, resource) when { resource.name == "x" };' })
    expect(set.warnings.join('\n')).toMatch(/no permit/i)
  })

  it('ships the published schema files byte-identical to the constants it enforces', () => {
    const root = join(__dirname, '..', 'schema')
    expect(readFileSync(join(root, 'jamjet.cedarschema'), 'utf-8')).toBe(CORE_SCHEMA)
    expect(readFileSync(join(root, 'default-input.cedarschema'), 'utf-8')).toBe(DEFAULT_INPUT_SCHEMA)
  })
})

describe('evaluation', () => {
  it('permit: allows a call a permit policy covers', () => {
    const d = loadCedarPolicies({ policies: PERMIT_READS }).evaluate(call('read_file'))
    expect(d.policyKind).toBe('allow')
    expect(d.blocked).toBe(false)
    expect(d.policyIds).toEqual(['allow-reads'])
  })

  it('default deny: blocks a call no permit covers', () => {
    const d = loadCedarPolicies({ policies: PERMIT_READS }).evaluate(call('write_file'))
    expect(d.policyKind).toBe('block')
    expect(d.blocked).toBe(true)
    expect(d.pattern).toBe('cedar:default-deny')
  })

  it('forbid: a satisfied forbid overrides a satisfied permit', () => {
    const set = loadCedarPolicies({
      policies: PERMIT_READS + '\n@id("no-secrets") forbid (principal, action, resource) when { resource.name == "read_secrets" };',
    })
    const d = set.evaluate(call('read_secrets'))
    expect(d.policyKind).toBe('block')
    expect(d.policyIds).toEqual(['no-secrets'])
    expect(d.pattern).toBe('cedar:no-secrets')
  })

  it('require-approval: a satisfied @require_approval permit holds the call', () => {
    const set = loadCedarPolicies({
      policies:
        PERMIT_READS + '\n@id("approve-deletes") @require_approval permit (principal, action, resource) when { resource.name like "delete_*" };',
    })
    const d = set.evaluate(call('delete_file'))
    expect(d.policyKind).toBe('require_approval')
    expect(d.blocked).toBe(false)
    expect(set.evaluate(call('read_file')).policyKind).toBe('allow')
  })

  it('require-approval: any satisfied approval permit holds, even when a plain permit also matches', () => {
    const set = loadCedarPolicies({
      policies: PERMIT_READS + '\n@id("approve-reads-of-hr") @require_approval("true") permit (principal, action, resource) when { resource.name == "read_hr" };',
    })
    expect(set.evaluate(call('read_hr')).policyKind).toBe('require_approval')
  })

  it('require-approval: a forbid still wins over an approval permit', () => {
    const set = loadCedarPolicies({
      policies:
        '@require_approval permit (principal, action, resource);\n@id("never") forbid (principal, action, resource) when { resource.name == "drop_db" };',
    })
    expect(set.evaluate(call('drop_db')).policyKind).toBe('block')
  })

  it('evaluation error fails closed: an erroring forbid blocks even though Cedar would allow', () => {
    // Cedar skips a policy whose evaluation errors, so this request is a Cedar Allow
    // with a diagnostic error. JamJet must not let an erroring forbid fall away.
    const set = loadCedarPolicies({
      policies:
        'permit (principal, action, resource);\n@id("cap") forbid (principal, action, resource) when { context.input has amount && context.input.amount * 1000000000000 > 5000000000000000 };',
      inputSchema: AMOUNT_INPUT,
    })
    const d = set.evaluate(call('pay', { args: { amount: 9_000_000_000 } }))
    expect(d.policyKind).toBe('block')
    expect(d.pattern).toBe('cedar:error')
    expect(d.errors.length).toBeGreaterThan(0)
    // Control: a small amount evaluates cleanly and is allowed.
    expect(set.evaluate(call('pay', { args: { amount: 3 } })).policyKind).toBe('allow')
  })

  it('request validation fails closed: an argument of the wrong type blocks', () => {
    const set = loadCedarPolicies({
      policies: 'permit (principal, action, resource) unless { context.input has amount && context.input.amount > 100 };',
      inputSchema: AMOUNT_INPUT,
    })
    expect(set.evaluate(call('pay', { args: { amount: 50 } })).policyKind).toBe('allow')
    // A string "500" would make `has amount && amount > 100` impossible to evaluate as intended.
    const d = set.evaluate(call('pay', { args: { amount: '500' } }))
    expect(d.policyKind).toBe('block')
    expect(d.pattern).toBe('cedar:error')
  })

  it('request validation fails closed: a non-integer number blocks', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);', inputSchema: AMOUNT_INPUT })
    expect(set.evaluate(call('pay', { args: { amount: 4.5 } })).policyKind).toBe('block')
  })

  it('drops arguments the schema does not declare (policies cannot read them)', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);', inputSchema: AMOUNT_INPUT })
    const d = set.evaluate(call('pay', { args: { amount: 5, memo: 'x', nested: { a: 1 } } }))
    expect(d.policyKind).toBe('allow')
  })

  it('an argument escape object cannot smuggle an entity reference into a String attribute', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);', inputSchema: AMOUNT_INPUT })
    const d = set.evaluate(call('read', { args: { path: { __entity: { type: 'JamJet::Agent', id: 'admin' } } } }))
    expect(d.policyKind).toBe('block')
  })

  it('blocks a server name that would make the Tool id ambiguous', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);' })
    expect(set.evaluate({ server: 'a___b', tool: 'c', args: {} }).policyKind).toBe('block')
    expect(set.evaluate({ server: 'a_', tool: '_b', args: {} }).policyKind).toBe('block')
    expect(set.evaluate({ server: '', tool: 'x', args: {} }).policyKind).toBe('block')
    expect(set.evaluate({ server: 'a', tool: 'b', args: {} }).policyKind).toBe('allow')
  })

  it('places the tool in its server so `resource in JamJet::Server` works', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource in JamJet::Server::"billing");' })
    expect(set.evaluate({ server: 'billing', tool: 'refund', args: {} }).policyKind).toBe('allow')
    expect(set.evaluate({ server: 'files', tool: 'refund', args: {} }).policyKind).toBe('block')
  })

  it('exposes principal, risk, approval status, and args digest in the request', () => {
    const set = loadCedarPolicies({
      policies: `permit (principal == JamJet::Agent::"agent-7", action, resource)
        when { principal.run_id == "run-1" && principal.kind == "agent" && context.risk == "low"
               && context.approval_status == "approved" && context.args_digest like "sha256:*" };`,
    })
    const good: ToolCallRequest = {
      server: 's',
      tool: 't',
      args: { q: 1 },
      principal: { id: 'agent-7', runId: 'run-1' },
      risk: 'low',
      approvalStatus: 'approved',
    }
    expect(set.evaluate(good).policyKind).toBe('allow')
    expect(set.evaluate({ ...good, approvalStatus: undefined }).policyKind).toBe('block')
    expect(set.evaluate({ ...good, risk: undefined }).policyKind).toBe('block')
    expect(set.evaluate({ ...good, principal: { id: 'agent-8', runId: 'run-1' } }).policyKind).toBe('block')
  })

  it('never throws: an internal failure is a block', () => {
    const set = loadCedarPolicies({ policies: 'permit (principal, action, resource);' })
    const d = set.evaluate({ server: 's', tool: 't', args: { a: 1n } as unknown as Record<string, unknown> })
    expect(d.policyKind).toBe('block')
  })
})

describe('AgentCore-style fixture (refund under 500)', () => {
  const set = loadCedarPoliciesFromFiles(
    join(FIXTURES, 'agentcore-refund', 'policies.cedar'),
    join(FIXTURES, 'agentcore-refund', 'input.cedarschema'),
  )
  const refund = (amount: number, tags: Record<string, string> = { username: 'refund-agent' }): ToolCallRequest => ({
    server: 'RefundTool',
    tool: 'process_refund',
    args: { orderId: '12345', amount, reason: 'Defective product' },
    principal: { id: 'user-123', tags },
  })

  it('permits the refund agent under the limit (the AWS docs example request)', () => {
    expect(set.evaluate(refund(450)).policyKind).toBe('allow')
  })
  it('denies at or above the limit', () => {
    expect(set.evaluate(refund(500)).policyKind).toBe('block')
  })
  it('denies another username', () => {
    expect(set.evaluate(refund(10, { username: 'support-agent' })).policyKind).toBe('block')
  })
  it('denies a principal without the username claim', () => {
    expect(set.evaluate(refund(10, {})).policyKind).toBe('block')
  })
  it('denies other tools (default deny)', () => {
    expect(set.evaluate({ ...refund(10), tool: 'issue_credit' }).policyKind).toBe('block')
  })
})

describe('combineDecisions (YAML + Cedar)', () => {
  const yaml = (policyKind: PolicyDecision['policyKind'], pattern: string | null = 'rule'): PolicyDecision => ({
    blocked: policyKind === 'block',
    policyKind,
    pattern,
    toolName: 't',
  })
  const set = loadCedarPolicies({
    policies: `${PERMIT_READS}
@id("approve-pay") @require_approval permit (principal, action, resource) when { resource.name == "pay" };`,
  })

  it('YAML only when no Cedar policy set is loaded', () => {
    expect(combineDecisions(yaml('allow', null), null).policyKind).toBe('allow')
    expect(combineDecisions(yaml('block'), null).policyKind).toBe('block')
  })
  it('YAML block wins over Cedar permit', () => {
    const c = combineDecisions(yaml('block', 'read_*'), set.evaluate(call('read_file')))
    expect(c.policyKind).toBe('block')
    expect(c.pattern).toBe('read_*')
  })
  it('Cedar deny wins over YAML allow (including the YAML no-match default)', () => {
    const c = combineDecisions(yaml('allow', null), set.evaluate(call('write_file')))
    expect(c.policyKind).toBe('block')
    expect(c.pattern).toBe('cedar:default-deny')
  })
  it('Cedar deny wins over YAML require_approval', () => {
    expect(combineDecisions(yaml('require_approval'), set.evaluate(call('write_file'))).policyKind).toBe('block')
  })
  it('YAML require_approval wins over Cedar permit', () => {
    expect(combineDecisions(yaml('require_approval', 'read_*'), set.evaluate(call('read_file'))).policyKind).toBe('require_approval')
  })
  it('Cedar require_approval wins over YAML allow', () => {
    const c = combineDecisions(yaml('allow', null), set.evaluate(call('pay')))
    expect(c.policyKind).toBe('require_approval')
    expect(c.pattern).toBe('cedar:approve-pay')
  })
  it('YAML audit with Cedar permit stays audit', () => {
    expect(combineDecisions(yaml('audit'), set.evaluate(call('read_file'))).policyKind).toBe('audit')
  })
  it('an unrecognized YAML kind fails closed', () => {
    expect(combineDecisions(yaml('mystery' as PolicyDecision['policyKind']), set.evaluate(call('read_file'))).policyKind).toBe('block')
  })
  it('Cedar evaluation error wins over YAML allow', () => {
    const errSet = loadCedarPolicies({ policies: 'permit (principal, action, resource);' })
    expect(combineDecisions(yaml('allow', null), errSet.evaluate({ server: 'a___b', tool: 'x', args: {} })).policyKind).toBe('block')
  })
})
