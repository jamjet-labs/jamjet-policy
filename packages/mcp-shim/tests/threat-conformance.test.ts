import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { evaluateToolsList, approveServer, THREAT_DEFAULTS } from '@jamjet/mcp-threat'
import type { ToolDefinition, TrustBaseline } from '@jamjet/mcp-threat'

interface ThreatCase {
  id: string
  risk_class: string | null
  baseline: Record<string, ToolDefinition[]>
  list: { server: string; tools: ToolDefinition[] }
  expect: { decision: string }
}

const suitePath = fileURLToPath(new URL('../../../conformance/mcp-threat-scenarios.yaml', import.meta.url))
const suite = parse(readFileSync(suitePath, 'utf-8')) as { cases: ThreatCase[] }

function buildBaseline(spec: Record<string, ToolDefinition[]>): TrustBaseline {
  let b: TrustBaseline = { version: 1, servers: {} }
  for (const [server, tools] of Object.entries(spec)) {
    b = approveServer(b, server, `id:${server}`, tools, '2026-06-02T00:00:00.000Z')
  }
  return b
}

describe('mcp-threat conformance', () => {
  for (const c of suite.cases) {
    it(c.id, () => {
      const out = evaluateToolsList(c.list.server, c.list.tools, buildBaseline(c.baseline), THREAT_DEFAULTS)
      expect(out.decision.decision).toBe(c.expect.decision)
      if (c.risk_class === null) {
        expect(out.decision.finding).toBeNull()
      } else {
        expect(out.decision.finding?.risk_class).toBe(c.risk_class)
      }
    })
  }
})
