import type { PolicyEvaluator } from '@jamjet/cloud'
import type { TrustBaseline } from '@jamjet/mcp-threat'
import { classifyBlastRadius, type BlastRadius } from './blast-radius.js'

// Named PolicyVerdict to avoid colliding with @jamjet/mcp-threat's `Decision`
// and @jamjet/cloud's `PolicyDecision`.
export type PolicyVerdict = 'allow' | 'block' | 'require_approval' | 'audit'

export interface GraphTool {
  name: string
  decision: PolicyVerdict
  rule: string | null
  risk?: BlastRadius
}

export interface GraphServer {
  name: string
  fingerprint: string
  approved_at: string
  tools: GraphTool[]
}

export interface CapabilityGraph {
  servers: GraphServer[]
  withRisk: boolean
}

export interface BuildGraphInput {
  baseline: TrustBaseline
  evaluator: PolicyEvaluator
  withRisk: boolean
}

export function buildCapabilityGraph(input: BuildGraphInput): CapabilityGraph {
  const servers: GraphServer[] = []
  for (const name of Object.keys(input.baseline.servers)) {
    const server = input.baseline.servers[name]
    if (!server) continue
    const tools: GraphTool[] = Object.keys(server.tools).map((toolName) => {
      const d = input.evaluator.evaluate(toolName)
      let decision: PolicyVerdict = 'allow'
      if (d.blocked) decision = 'block'
      else if (d.policyKind === 'require_approval') decision = 'require_approval'
      else if (d.policyKind === 'audit') decision = 'audit'
      const tool: GraphTool = { name: toolName, decision, rule: d.pattern ?? null }
      if (input.withRisk) tool.risk = classifyBlastRadius(toolName)
      return tool
    })
    servers.push({ name, fingerprint: server.fingerprint, approved_at: server.approved_at, tools })
  }
  return { servers, withRisk: input.withRisk }
}
