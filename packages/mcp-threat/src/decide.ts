import type { Decision, ThreatAction, ThreatConfig, ThreatDecision, ThreatFinding, ThreatRiskClass } from './types.js'

export const DECISION_SEVERITY: Record<Decision, number> = {
  ALLOWED: 0,
  AUDIT: 1,
  WAITING_FOR_APPROVAL: 2,
  BLOCKED: 3,
}

const ACTION_SEVERITY: Record<ThreatAction, number> = {
  allow: 0,
  audit: 1,
  require_approval: 2,
  block: 3,
}

const ACTION_TO_DECISION: Record<ThreatAction, Decision> = {
  allow: 'ALLOWED',
  audit: 'AUDIT',
  require_approval: 'WAITING_FOR_APPROVAL',
  block: 'BLOCKED',
}

const RISK_TO_CONFIG_KEY: Record<ThreatRiskClass, keyof ThreatConfig> = {
  first_seen: 'on_first_seen',
  tool_definition_drift: 'on_definition_drift',
  tool_shadowing: 'on_tool_shadow',
  token_passthrough: 'on_token_passthrough',
}

export function strictest(a: Decision, b: Decision): Decision {
  return DECISION_SEVERITY[a] >= DECISION_SEVERITY[b] ? a : b
}

export function decideFromFindings(findings: ThreatFinding[], config: ThreatConfig): ThreatDecision {
  let chosen: ThreatFinding | null = null
  let chosenSeverity = -1
  let chosenAction: ThreatAction = 'allow'
  for (const f of findings) {
    const action = config[RISK_TO_CONFIG_KEY[f.risk_class]]
    if (ACTION_SEVERITY[action] > chosenSeverity) {
      chosenSeverity = ACTION_SEVERITY[action]
      chosen = f
      chosenAction = action
    }
  }
  if (chosen === null) return { decision: 'ALLOWED', finding: null }
  return { decision: ACTION_TO_DECISION[chosenAction], finding: chosen }
}
