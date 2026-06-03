import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseThreatConfig, loadThreatConfig } from '../src/threat-config.js'

describe('parseThreatConfig', () => {
  it('returns documented defaults when no threat block is present', () => {
    expect(parseThreatConfig({ version: 1, rules: [] })).toEqual({
      on_first_seen: 'require_approval',
      on_definition_drift: 'block',
      on_tool_shadow: 'block',
      on_token_passthrough: 'block',
    })
  })

  it('overrides only the provided keys, ignoring invalid actions', () => {
    const cfg = parseThreatConfig({ threat: { on_definition_drift: 'audit', on_first_seen: 'nonsense' } })
    expect(cfg.on_definition_drift).toBe('audit')
    expect(cfg.on_first_seen).toBe('require_approval') // invalid value falls back to default
  })
})

describe('loadThreatConfig', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-cfg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads the threat block from a policy file path', () => {
    const p = join(dir, 'policy.yaml')
    writeFileSync(p, 'version: 1\nrules: []\nthreat:\n  on_definition_drift: audit\n', 'utf-8')
    expect(loadThreatConfig(p).on_definition_drift).toBe('audit')
  })

  it('returns defaults when the file is missing', () => {
    expect(loadThreatConfig(join(dir, 'nope.yaml')).on_definition_drift).toBe('block')
  })
})
