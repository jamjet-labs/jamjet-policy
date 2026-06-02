import { describe, it, expect } from 'vitest'
import { decideFromFindings, strictest, DECISION_SEVERITY } from '../src/decide.js'
import type { ThreatConfig, ThreatFinding } from '../src/types.js'

const config: ThreatConfig = {
  on_first_seen: 'require_approval',
  on_definition_drift: 'block',
  on_tool_shadow: 'block',
  on_token_passthrough: 'block',
}

describe('decideFromFindings', () => {
  it('returns ALLOWED with no finding when there are no findings', () => {
    expect(decideFromFindings([], config)).toEqual({ decision: 'ALLOWED', finding: null })
  })

  it('maps a drift finding to BLOCKED and returns that finding', () => {
    const f: ThreatFinding = { risk_class: 'tool_definition_drift', server: 's', tool: 't', detail: 'd' }
    const out = decideFromFindings([f], config)
    expect(out.decision).toBe('BLOCKED')
    expect(out.finding).toBe(f)
  })

  it('picks the most severe action across multiple findings', () => {
    const firstSeen: ThreatFinding = { risk_class: 'first_seen', server: 's', tool: null, detail: 'd' }
    const drift: ThreatFinding = { risk_class: 'tool_definition_drift', server: 's', tool: 't', detail: 'd' }
    const out = decideFromFindings([firstSeen, drift], config)
    expect(out.decision).toBe('BLOCKED')
    expect(out.finding).toBe(drift)
  })
})

describe('strictest', () => {
  it('returns the more severe of two decisions', () => {
    expect(strictest('ALLOWED', 'BLOCKED')).toBe('BLOCKED')
    expect(strictest('WAITING_FOR_APPROVAL', 'AUDIT')).toBe('WAITING_FOR_APPROVAL')
    expect(strictest('AUDIT', 'ALLOWED')).toBe('AUDIT')
  })
  it('severity order is BLOCKED > WAITING_FOR_APPROVAL > AUDIT > ALLOWED', () => {
    expect(DECISION_SEVERITY.BLOCKED).toBeGreaterThan(DECISION_SEVERITY.WAITING_FOR_APPROVAL)
    expect(DECISION_SEVERITY.WAITING_FOR_APPROVAL).toBeGreaterThan(DECISION_SEVERITY.AUDIT)
    expect(DECISION_SEVERITY.AUDIT).toBeGreaterThan(DECISION_SEVERITY.ALLOWED)
  })
})
