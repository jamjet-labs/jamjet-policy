import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvaluator, decidePolicy } from '../src/policy.js'
import type { AuthzAction } from '../src/types.js'

function action(tool: string): AuthzAction {
  return { server: 'mcp', tool, args: {} }
}

let policyPath: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-policy-'))
  policyPath = join(dir, 'policy.yaml')
  writeFileSync(
    policyPath,
    'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n  - match: "payments.*"\n    action: require_approval\n',
    'utf-8',
  )
})

describe('decidePolicy', () => {
  it('blocks a tool matching a block rule', () => {
    const v = decidePolicy(buildEvaluator(policyPath), action('delete_user'))
    expect(v.kind).toBe('BLOCK')
  })
  it('holds a tool matching a require_approval rule', () => {
    const v = decidePolicy(buildEvaluator(policyPath), action('payments.transfer'))
    expect(v.kind).toBe('PENDING')
  })
  it('allows an unmatched tool', () => {
    const v = decidePolicy(buildEvaluator(policyPath), action('search'))
    expect(v.kind).toBe('ALLOW')
  })
  it('allows a tool matching an audit rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extauthz-policy-audit-'))
    const p = join(dir, 'policy.yaml')
    writeFileSync(p, 'version: 1\nrules:\n  - match: "log_*"\n    action: audit\n', 'utf-8')
    expect(decidePolicy(buildEvaluator(p), action('log_event')).kind).toBe('ALLOW')
  })
  it('fails closed (BLOCK) for an unrecognized policyKind', () => {
    const fakeEvaluator = {
      evaluate: () => ({ blocked: false, policyKind: 'mystery', pattern: null, toolName: 'x' }),
    } as unknown as Parameters<typeof decidePolicy>[0]
    expect(decidePolicy(fakeEvaluator, action('whatever')).kind).toBe('BLOCK')
  })
})
