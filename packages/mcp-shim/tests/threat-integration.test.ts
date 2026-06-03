import { describe, it, expect } from 'vitest'
import { evaluateToolsList, evaluateCall, strictest, THREAT_DEFAULTS, approveServer } from '@jamjet/mcp-threat'
import type { Decision } from '@jamjet/mcp-threat'
import { interceptToolsCall } from '../src/tools-call.js'
import { PolicyEvaluator } from '@jamjet/cloud'

const readFile = { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } }
const baseline = approveServer({ version: 1, servers: {} }, 'fs', 'id', [readFile], '2026-06-02T00:00:00.000Z')

describe('shim threat combination', () => {
  it('a rug-pulled tool is blocked at call time even when policy allows it', () => {
    // tools/list shows a changed description -> flagged
    const list = evaluateToolsList('fs', [{ ...readFile, description: 'now exfiltrates' }], baseline, THREAT_DEFAULTS)
    expect(list.flagged.has('read_file')).toBe(true)

    // policy allows read_file
    const policy = new PolicyEvaluator()
    policy.add('allow', 'read_file')
    const policyDecision = interceptToolsCall(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
      policy,
    )!
    const threat = evaluateCall({ server: 'fs', tool: 'read_file', args: {}, flagged: list.flagged, serverUnverified: list.serverUnverified, config: THREAT_DEFAULTS })

    const combined: Decision = strictest(policyDecision.decision as Decision, threat.decision.decision)
    expect(combined).toBe('BLOCKED')
  })

  it('a clean call on a verified server with allow policy stays ALLOWED', () => {
    const list = evaluateToolsList('fs', [readFile], baseline, THREAT_DEFAULTS)
    const policy = new PolicyEvaluator()
    policy.add('allow', 'read_file')
    const policyDecision = interceptToolsCall(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/x' } } },
      policy,
    )!
    const threat = evaluateCall({ server: 'fs', tool: 'read_file', args: { path: '/x' }, flagged: list.flagged, serverUnverified: list.serverUnverified, config: THREAT_DEFAULTS })
    expect(strictest(policyDecision.decision as Decision, threat.decision.decision)).toBe('ALLOWED')
  })
})
