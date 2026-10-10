import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policyValidate, policyExplain } from '../src/policy/commands.js'

function files(entries: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'jamjet-policy-cmd-'))
  const out: Record<string, string> = {}
  for (const [name, text] of Object.entries(entries)) {
    out[name] = join(dir, name)
    writeFileSync(out[name]!, text, 'utf-8')
  }
  return out
}

const YAML = 'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n  - match: "pay*"\n    action: require_approval\n'
const CEDAR = `
@id("allow-all") permit (principal, action, resource);
@id("no-refund-over-500") forbid (principal, action, resource == JamJet::Tool::"RefundTool___process_refund")
  when { context.input has amount && context.input.amount >= 500 };
@id("approve-export") @require_approval permit (principal, action, resource) when { resource.name == "export" };
`
const INPUT = 'namespace JamJet::Input { type ToolInput = { amount?: Long }; }'

describe('jamjet policy validate', () => {
  it('passes a valid YAML file and a valid Cedar set', () => {
    const f = files({ 'policy.yaml': YAML, 'p.cedar': CEDAR, 'in.cedarschema': INPUT })
    const r = policyValidate({ policy: f['policy.yaml'], cedar: f['p.cedar'], cedarSchema: f['in.cedarschema'] })
    expect(r.exitCode).toBe(0)
    expect(r.out).toMatch(/cedar: 3 policies valid/)
    expect(r.out).toMatch(/approve-export \(require_approval\)/)
  })

  it('fails on a Cedar schema validation error and names the policy', () => {
    const f = files({ 'p.cedar': '@id("bad") permit (principal, action, resource) when { context.input.amount > 1 };' })
    const r = policyValidate({ cedar: f['p.cedar'] })
    expect(r.exitCode).toBe(1)
    expect(r.err).toMatch(/bad/)
  })

  it('fails on an invalid YAML policy', () => {
    const f = files({ 'policy.yaml': 'version: 2\nrules: []\n' })
    expect(policyValidate({ policy: f['policy.yaml'] }).exitCode).toBe(1)
  })

  it('reports a Cedar set with no permit as a warning', () => {
    const f = files({ 'p.cedar': 'forbid (principal, action, resource) when { resource.name == "x" };' })
    const r = policyValidate({ cedar: f['p.cedar'] })
    expect(r.exitCode).toBe(0)
    expect(r.out).toMatch(/warning: no permit/)
  })

  it('needs something to validate', () => {
    expect(policyValidate({}).exitCode).toBe(64)
  })
})

describe('jamjet policy explain', () => {
  const f = files({ 'policy.yaml': YAML, 'p.cedar': CEDAR, 'in.cedarschema': INPUT })
  const base = { policy: f['policy.yaml'], cedar: f['p.cedar'], cedarSchema: f['in.cedarschema'] }

  it('explains a Cedar forbid that overrides a YAML allow', () => {
    const r = policyExplain({ ...base, tool: 'process_refund', server: 'RefundTool', args: '{"amount": 900}' })
    expect(r.exitCode).toBe(0)
    expect(r.out).toMatch(/yaml:\s+allow \(no rule matched\)/)
    expect(r.out).toMatch(/cedar:\s+block .*no-refund-over-500/)
    expect(r.out).toMatch(/result:\s+block \(from cedar\)/)
  })

  it('explains a YAML block that overrides a Cedar permit', () => {
    const r = policyExplain({ ...base, tool: 'delete_user' })
    expect(r.out).toMatch(/yaml:\s+block \(rule 'delete_\*'\)/)
    expect(r.out).toMatch(/result:\s+block \(from yaml\)/)
  })

  it('explains a Cedar require-approval', () => {
    const r = policyExplain({ ...base, tool: 'export' })
    expect(r.out).toMatch(/result:\s+require_approval \(from cedar\)/)
  })

  it('emits JSON with both engine decisions', () => {
    const r = policyExplain({ ...base, tool: 'process_refund', server: 'RefundTool', args: '{"amount": 10}', json: true })
    const j = JSON.parse(r.out)
    expect(j.result.policyKind).toBe('allow')
    expect(j.yaml.policyKind).toBe('allow')
    expect(j.cedar.policyIds).toEqual(['allow-all'])
  })

  it('passes principal, tags, risk and approval status through to Cedar', () => {
    const g = files({
      'p.cedar': `permit (principal == JamJet::Agent::"bot", action, resource)
        when { principal.hasTag("team") && principal.getTag("team") == "ops" && context.risk == "low" && context.approval_status == "approved" };`,
    })
    const r = policyExplain({ cedar: g['p.cedar'], tool: 't', agent: 'bot', tags: ['team=ops'], risk: 'low', approvalStatus: 'approved' })
    expect(r.out).toMatch(/result:\s+allow/)
    const r2 = policyExplain({ cedar: g['p.cedar'], tool: 't', agent: 'bot', tags: ['team=dev'], risk: 'low', approvalStatus: 'approved' })
    expect(r2.out).toMatch(/result:\s+block/)
  })

  it('rejects malformed --args, --tag and --approval-status', () => {
    expect(policyExplain({ ...base, tool: 't', args: '{nope' }).exitCode).toBe(64)
    expect(policyExplain({ ...base, tool: 't', args: '[1]' }).exitCode).toBe(64)
    expect(policyExplain({ ...base, tool: 't', tags: ['noequals'] }).exitCode).toBe(64)
    expect(policyExplain({ ...base, tool: 't', approvalStatus: 'yes' }).exitCode).toBe(64)
  })

  it('requires --tool', () => {
    expect(policyExplain({ ...base }).exitCode).toBe(64)
  })

  it('fails when the Cedar set does not load', () => {
    const g = files({ 'p.cedar': 'permit (principal, action' })
    expect(policyExplain({ cedar: g['p.cedar'], tool: 't' }).exitCode).toBe(1)
  })
})

describe('jamjet policy explain matches the PDP hold flow (review 7)', () => {
  const g = files({ 'p.cedar': '@id("ask") @require_approval permit (principal, action, resource);' })
  const run = (approvalStatus: string) => policyExplain({ cedar: g['p.cedar'], tool: 'pay', approvalStatus }).out
  it('approved: the PDP allows once and consumes the approval', () => {
    expect(run('approved')).toMatch(/pdp:\s+allow once \(consumes the approval\)/)
  })
  it('rejected: the PDP blocks', () => {
    expect(run('rejected')).toMatch(/pdp:\s+block \(approval rejected\)/)
  })
  it('pending and none: the PDP holds', () => {
    expect(run('pending')).toMatch(/pdp:\s+hold/)
    expect(run('none')).toMatch(/pdp:\s+hold/)
  })
  it('a plain allow with an approved hold also consumes it', () => {
    const h = files({ 'p.cedar': 'permit (principal, action, resource);' })
    expect(policyExplain({ cedar: h['p.cedar'], tool: 'pay', approvalStatus: 'approved' }).out).toMatch(/pdp:\s+allow \(consumes the approval\)/)
    expect(policyExplain({ cedar: h['p.cedar'], tool: 'pay' }).out).toMatch(/pdp:\s+allow$/m)
  })
  it('--kind sets the principal kind', () => {
    const h = files({ 'p.cedar': 'permit (principal, action, resource) when { principal.kind == "user" };' })
    expect(policyExplain({ cedar: h['p.cedar'], tool: 't', kind: 'user' }).out).toMatch(/result:\s+allow/)
    expect(policyExplain({ cedar: h['p.cedar'], tool: 't' }).out).toMatch(/result:\s+block/)
  })
  it('says where the PDP gets the server name', () => {
    expect(policyExplain({ cedar: g['p.cedar'], tool: 't', server: 'payments' }).out).toMatch(/--server-name or --server-header/)
  })
})

describe('copilot: explain keeps a __proto__ tag', () => {
  it('a forbid on that tag fires', () => {
    const g = files({ 'p.cedar': 'permit (principal, action, resource);\nforbid (principal, action, resource) when { principal.hasTag("__proto__") };' })
    expect(policyExplain({ cedar: g['p.cedar'], tool: 't', tags: ['__proto__=x'] }).out).toMatch(/result:\s+block/)
  })
})
