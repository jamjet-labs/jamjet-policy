import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMcpSecurityReceipt, appendReceipt, RECEIPT_VERSION } from '../src/receipt.js'
import type { ThreatFinding } from '../src/types.js'

const finding: ThreatFinding = {
  risk_class: 'tool_definition_drift',
  server: 'filesystem',
  tool: 'read_file',
  detail: 'definition changed',
  baseline_hash: 'sha256:aaa',
  observed_hash: 'sha256:bbb',
}

describe('buildMcpSecurityReceipt', () => {
  it('produces a content-addressed receipt with the MCP profile version', () => {
    const r = buildMcpSecurityReceipt(finding, 'BLOCKED', 'tools/call', '2026-06-02T00:00:00.000Z')
    expect(r.version).toBe(RECEIPT_VERSION)
    expect(r.server).toBe('filesystem')
    expect(r.tool).toBe('read_file')
    expect(r.risk_class).toBe('tool_definition_drift')
    expect(r.policy.decision).toBe('BLOCKED')
    expect(r.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is deterministic for the same inputs and changes when the decision changes', () => {
    const a = buildMcpSecurityReceipt(finding, 'BLOCKED', 'tools/call', '2026-06-02T00:00:00.000Z')
    const b = buildMcpSecurityReceipt(finding, 'BLOCKED', 'tools/call', '2026-06-02T00:00:00.000Z')
    const c = buildMcpSecurityReceipt(finding, 'AUDIT', 'tools/call', '2026-06-02T00:00:00.000Z')
    expect(a.receipt_hash).toBe(b.receipt_hash)
    expect(a.receipt_hash).not.toBe(c.receipt_hash)
  })
})

describe('appendReceipt', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-rcpt-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('appends one JSON line per receipt', () => {
    const path = join(dir, 'sub', 'mcp-receipts.jsonl')
    const r = buildMcpSecurityReceipt(finding, 'BLOCKED', 'tools/call', '2026-06-02T00:00:00.000Z')
    appendReceipt(path, r)
    appendReceipt(path, r)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).receipt_hash).toBe(r.receipt_hash)
  })
})
