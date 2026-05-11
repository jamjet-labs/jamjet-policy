import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { evaluateHookInput } from '../src/hook.js'
import { PolicyEvaluator } from '@jamjet/cloud'

interface ConformanceCase {
  id: string
  policy: { version: number; rules: Array<{ match: string; action: 'allow' | 'block' | 'require_approval' | 'audit' }> }
  tool: string
  expect: {
    decision: string
    rule: string | null
    rule_kind: string | null
  }
  requires_mcp_prefix_strip?: boolean
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const suitePath = join(__dirname, '../../../conformance/policy-decisions.yaml')
const suite = parse(readFileSync(suitePath, 'utf-8')) as { cases: ConformanceCase[] }

describe('claude-code-hook conformance', () => {
  for (const c of suite.cases) {
    it(c.id, () => {
      const ev = new PolicyEvaluator()
      for (const r of c.policy.rules) {
        ev.add(r.action, r.match)
      }
      // The hook adapter strips mcp__server__ prefix — perfect for the
      // `requires_mcp_prefix_strip: true` case, but harmless for others.
      const result = evaluateHookInput({ tool_name: c.tool, tool_input: {} }, ev)
      expect(result.decision).toBe(c.expect.decision)
      expect(result.rule).toBe(c.expect.rule)
      expect(result.rule_kind).toBe(c.expect.rule_kind)
    })
  }
})
