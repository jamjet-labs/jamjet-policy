import type { ThreatConfig, ThreatDecision, ThreatFinding } from './types.js'
import { detectTokenPassthrough } from './detectors/token.js'
import { decideFromFindings } from './decide.js'

export interface CallEvaluationInput {
  server: string
  tool: string
  args: Record<string, unknown>
  /** Tools flagged by the most recent tools/list (drift/new-tool). */
  flagged: Map<string, ThreatFinding>
  /** True when the server was never approved (first-seen). */
  serverUnverified: boolean
  config: ThreatConfig
}

export interface CallEvaluation {
  findings: ThreatFinding[]
  decision: ThreatDecision
}

export function evaluateCall(input: CallEvaluationInput): CallEvaluation {
  const findings: ThreatFinding[] = []
  // Note: this first_seen finding carries the tool name (the list-eval first_seen finding has tool: null), because here we are evaluating a concrete call.
  if (input.serverUnverified) {
    findings.push({
      risk_class: 'first_seen',
      server: input.server,
      tool: input.tool,
      detail: `call to tool '${input.tool}' on unverified server '${input.server}'`,
    })
  }
  const flaggedFinding = input.flagged.get(input.tool)
  if (flaggedFinding) findings.push(flaggedFinding)
  findings.push(...detectTokenPassthrough(input.tool, input.args, input.server))
  return { findings, decision: decideFromFindings(findings, input.config) }
}
