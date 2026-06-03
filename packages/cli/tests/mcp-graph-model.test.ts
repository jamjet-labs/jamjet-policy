import { describe, it, expect } from 'vitest'
import { PolicyEvaluator } from '@jamjet/cloud'
import { approveServer } from '@jamjet/mcp-threat'
import { buildCapabilityGraph } from '../src/mcp/graph-model.js'

type Action = 'allow' | 'block' | 'require_approval' | 'audit'
function evaluatorWith(rules: Array<[Action, string]>): PolicyEvaluator {
  const ev = new PolicyEvaluator()
  for (const [action, match] of rules) ev.add(action, match)
  return ev
}

const baseline = approveServer({ version: 1, servers: {} }, 'demo', 'id', [
  { name: 'read_file' }, { name: 'delete_all' }, { name: 'send_email' },
], '2026-06-03T00:00:00.000Z')

describe('buildCapabilityGraph', () => {
  it('maps policy decisions onto tools', () => {
    const ev = evaluatorWith([['block', '*delete*'], ['require_approval', 'send_*']])
    const g = buildCapabilityGraph({ baseline, evaluator: ev, withRisk: false })
    const demo = g.servers.find((s) => s.name === 'demo')!
    const byName = Object.fromEntries(demo.tools.map((t) => [t.name, t]))
    expect(byName.read_file!.decision).toBe('allow')
    expect(byName.read_file!.rule).toBeNull()
    expect(byName.delete_all!.decision).toBe('block')
    expect(byName.delete_all!.rule).toBe('*delete*')
    expect(byName.send_email!.decision).toBe('require_approval')
  })

  it('omits risk unless withRisk', () => {
    const g = buildCapabilityGraph({ baseline, evaluator: new PolicyEvaluator(), withRisk: false })
    expect(g.servers[0]!.tools[0]!.risk).toBeUndefined()
    expect(g.withRisk).toBe(false)
  })

  it('adds risk buckets when withRisk', () => {
    const g = buildCapabilityGraph({ baseline, evaluator: new PolicyEvaluator(), withRisk: true })
    const demo = g.servers.find((s) => s.name === 'demo')!
    const byName = Object.fromEntries(demo.tools.map((t) => [t.name, t]))
    expect(byName.delete_all!.risk).toBe('destructive')
    expect(byName.read_file!.risk).toBe('read')
  })
})
