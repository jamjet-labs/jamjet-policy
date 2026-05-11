import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { interceptToolsCall } from '../src/tools-call.js'
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

const suitePath = fileURLToPath(new URL('../../../conformance/policy-decisions.yaml', import.meta.url))
const suite = parse(readFileSync(suitePath, 'utf-8')) as { cases: ConformanceCase[] }

describe('mcp-shim conformance', () => {
  for (const c of suite.cases) {
    // mcp-shim doesn't strip prefixes — it operates on raw JSON-RPC tool names.
    // The Claude Code hook adapter strips prefixes; the MCP shim sees what the
    // MCP client sends, which already has no prefix.
    if (c.requires_mcp_prefix_strip) continue

    it(c.id, () => {
      const ev = new PolicyEvaluator()
      for (const r of c.policy.rules) ev.add(r.action, r.match)
      const req = {
        jsonrpc: '2.0' as const, id: 1, method: 'tools/call',
        params: { name: c.tool, arguments: {} },
      }
      const result = interceptToolsCall(req, ev)
      expect(result).not.toBeNull()
      expect(result!.decision).toBe(c.expect.decision)
      expect(result!.rule).toBe(c.expect.rule)
      expect(result!.rule_kind).toBe(c.expect.rule_kind)
    })
  }
})
