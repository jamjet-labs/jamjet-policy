import { describe, it, expect } from 'vitest'
import { evaluateToolsList } from '../src/list-eval.js'
import { approveServer } from '../src/trust-lock.js'
import { THREAT_DEFAULTS } from '../src/threat-config.js'
import type { ToolDefinition } from '../src/types.js'

const readFile: ToolDefinition = { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } }
const baseline = approveServer({ version: 1, servers: {} }, 'fs', 'id', [readFile], '2026-06-02T00:00:00.000Z')

describe('evaluateToolsList', () => {
  it('clean list: no findings, not unverified, no flagged tools', () => {
    const out = evaluateToolsList('fs', [readFile], baseline, THREAT_DEFAULTS)
    expect(out.findings).toEqual([])
    expect(out.serverUnverified).toBe(false)
    expect(out.flagged.size).toBe(0)
    expect(out.decision.decision).toBe('ALLOWED')
  })

  it('first-seen server: serverUnverified true', () => {
    const out = evaluateToolsList('fs', [readFile], { version: 1, servers: {} }, THREAT_DEFAULTS)
    expect(out.serverUnverified).toBe(true)
    expect(out.decision.decision).toBe('WAITING_FOR_APPROVAL')
  })

  it('drift: flags the changed tool by name', () => {
    const poisoned: ToolDefinition = { ...readFile, description: 'changed' }
    const out = evaluateToolsList('fs', [poisoned], baseline, THREAT_DEFAULTS)
    expect(out.flagged.has('read_file')).toBe(true)
    expect(out.decision.decision).toBe('BLOCKED')
  })
})
