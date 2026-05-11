import { describe, it, expect, beforeEach } from 'vitest'
import { jamjetGuardrail, JamjetPolicyBlocked, JamjetApprovalRequired } from '../src/guardrail.js'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function writePolicy(dir: string, body: string): string {
  const p = join(dir, 'policy.yaml')
  writeFileSync(p, body)
  return p
}

describe('jamjetGuardrail', () => {
  let dir: string
  let auditDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jjog-'))
    auditDir = mkdtempSync(join(tmpdir(), 'jjog-audit-'))
  })

  it('throws JamjetPolicyBlocked for a matching block rule', () => {
    const policyPath = writePolicy(dir, 'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')
    const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })
    expect(() => guard({ toolName: 'database.delete_all', toolArgs: {} })).toThrowError(JamjetPolicyBlocked)
  })

  it('throws JamjetApprovalRequired for require_approval', () => {
    const policyPath = writePolicy(dir, 'version: 1\nrules:\n  - { match: "payments.*", action: require_approval }\n')
    const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })
    expect(() => guard({ toolName: 'payments.refund', toolArgs: { amount: 100 } })).toThrowError(JamjetApprovalRequired)
  })

  it('passes through (no throw) for ALLOWED', () => {
    const policyPath = writePolicy(dir, 'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')
    const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })
    expect(() => guard({ toolName: 'database.read_orders', toolArgs: {} })).not.toThrow()
  })

  it('passes through for AUDIT (no throw) and writes audit event', () => {
    const policyPath = writePolicy(dir, 'version: 1\nrules:\n  - { match: "slack.send_message", action: audit }\n')
    const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })
    expect(() => guard({ toolName: 'slack.send_message', toolArgs: { text: 'hi' } })).not.toThrow()
    const today = new Date().toISOString().slice(0, 10)
    const path = join(auditDir, today, 'openai-guardrail.jsonl')
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    const event = JSON.parse(lines[lines.length - 1]!)
    expect(event.decision).toBe('AUDIT')
    expect(event.adapter).toBe('openai-guardrail')
    expect(event.host).toBe('openai-agents-sdk')
    expect(event.schema_version).toBe(1)
  })

  it('writes audit event for blocked decisions before throwing', () => {
    const policyPath = writePolicy(dir, 'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')
    const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })
    try { guard({ toolName: 'database.delete_all', toolArgs: { reason: 'cleanup' } }) } catch {}
    const today = new Date().toISOString().slice(0, 10)
    const path = join(auditDir, today, 'openai-guardrail.jsonl')
    expect(existsSync(path)).toBe(true)
    const event = JSON.parse(readFileSync(path, 'utf-8').trim().split('\n').slice(-1)[0]!)
    expect(event.decision).toBe('BLOCKED')
    expect(event.executed).toBe(false)
    expect(event.rule).toBe('*delete*')
  })
})
