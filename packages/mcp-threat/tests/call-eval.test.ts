import { describe, it, expect } from 'vitest'
import { evaluateCall } from '../src/call-eval.js'
import { THREAT_DEFAULTS } from '../src/threat-config.js'
import type { ThreatFinding } from '../src/types.js'

const driftFinding: ThreatFinding = { risk_class: 'tool_definition_drift', server: 'fs', tool: 'read_file', detail: 'd' }

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

describe('evaluateCall', () => {
  it('blocks a call to a flagged (drifted) tool', () => {
    const flagged = new Map<string, ThreatFinding>([['read_file', driftFinding]])
    const out = evaluateCall({ server: 'fs', tool: 'read_file', args: {}, flagged, serverUnverified: false, config: THREAT_DEFAULTS })
    expect(out.decision.decision).toBe('BLOCKED')
  })

  it('requires approval for any call when the server is unverified', () => {
    const out = evaluateCall({ server: 'fs', tool: 'read_file', args: {}, flagged: new Map(), serverUnverified: true, config: THREAT_DEFAULTS })
    expect(out.decision.decision).toBe('WAITING_FOR_APPROVAL')
  })

  it('flags token passthrough on a clean tool', () => {
    const out = evaluateCall({ server: 'fs', tool: 'read_file', args: { auth: jwt({ aud: 'github' }) }, flagged: new Map(), serverUnverified: false, config: THREAT_DEFAULTS })
    expect(out.decision.decision).toBe('BLOCKED')
    expect(out.findings.some(f => f.risk_class === 'token_passthrough')).toBe(true)
  })

  it('allows a clean call to a clean tool on a verified server', () => {
    const out = evaluateCall({ server: 'fs', tool: 'read_file', args: { path: '/x' }, flagged: new Map(), serverUnverified: false, config: THREAT_DEFAULTS })
    expect(out.decision.decision).toBe('ALLOWED')
    expect(out.findings).toEqual([])
  })
})
