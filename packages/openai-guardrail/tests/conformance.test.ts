import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jamjetGuardrail, JamjetPolicyBlocked, JamjetApprovalRequired } from '../src/guardrail.js'

interface ConformanceCase {
  id: string
  policy: { version: number; rules: Array<{ match: string; action: 'allow' | 'block' | 'require_approval' | 'audit' }> }
  tool: string
  expect: { decision: string; rule: string | null; rule_kind: string | null }
  requires_mcp_prefix_strip?: boolean
}

const suitePath = fileURLToPath(new URL('../../../conformance/policy-decisions.yaml', import.meta.url))
const suite = parse(readFileSync(suitePath, 'utf-8')) as { cases: ConformanceCase[] }

describe('openai-guardrail conformance', () => {
  for (const c of suite.cases) {
    if (c.requires_mcp_prefix_strip) continue // adapter-specific to claude-code-hook
    it(c.id, () => {
      const dir = mkdtempSync(join(tmpdir(), 'jjog-conf-'))
      const policyPath = join(dir, 'policy.yaml')
      // YAML parser accepts JSON, so dumping the case policy as JSON suffices.
      writeFileSync(policyPath, JSON.stringify(c.policy))
      const auditDir = mkdtempSync(join(tmpdir(), 'jjog-conf-audit-'))
      const guard = jamjetGuardrail({ policy: policyPath, auditDestination: auditDir })

      let thrown: Error | null = null
      try { guard({ toolName: c.tool, toolArgs: {} }) } catch (e) { thrown = e as Error }

      // Read the audit event the guardrail just wrote
      const today = new Date().toISOString().slice(0, 10)
      const auditPath = join(auditDir, today, 'openai-guardrail.jsonl')
      const lines = readFileSync(auditPath, 'utf-8').trim().split('\n')
      const event = JSON.parse(lines[lines.length - 1]!)

      expect(event.decision).toBe(c.expect.decision)
      expect(event.rule).toBe(c.expect.rule)
      expect(event.rule_kind).toBe(c.expect.rule_kind)

      // Decisions that should throw
      if (c.expect.decision === 'BLOCKED') {
        expect(thrown).toBeInstanceOf(JamjetPolicyBlocked)
      } else if (c.expect.decision === 'WAITING_FOR_APPROVAL') {
        expect(thrown).toBeInstanceOf(JamjetApprovalRequired)
      } else {
        expect(thrown).toBeNull()
      }
    })
  }
})
