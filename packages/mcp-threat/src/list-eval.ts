import type { ThreatConfig, ThreatDecision, ThreatFinding, ToolDefinition, TrustBaseline } from './types.js'
import { detectDrift } from './detectors/drift.js'
import { decideFromFindings } from './decide.js'

export interface ToolsListEvaluation {
  findings: ThreatFinding[]
  /** True when the server is not in the baseline at all (first-seen). */
  serverUnverified: boolean
  /** tool name -> finding, for enforcement at call time. */
  flagged: Map<string, ThreatFinding>
  decision: ThreatDecision
}

export function evaluateToolsList(
  server: string,
  advertisedTools: ToolDefinition[],
  baseline: TrustBaseline,
  config: ThreatConfig,
): ToolsListEvaluation {
  const findings = detectDrift(server, advertisedTools, baseline)
  const serverUnverified = findings.some((f) => f.risk_class === 'first_seen')
  const flagged = new Map<string, ThreatFinding>()
  for (const f of findings) {
    if (f.tool !== null) flagged.set(f.tool, f)
  }
  return { findings, serverUnverified, flagged, decision: decideFromFindings(findings, config) }
}
