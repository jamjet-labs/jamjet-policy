import type { ThreatFinding, ToolDefinition, TrustBaseline } from '../types.js'
import { hashToolDefinition } from '../fingerprint.js'

export function detectDrift(
  server: string,
  advertisedTools: ToolDefinition[],
  baseline: TrustBaseline,
): ThreatFinding[] {
  const known = baseline.servers[server]
  if (!known) {
    return [{
      risk_class: 'first_seen',
      server,
      tool: null,
      detail: `server '${server}' is not in the trust baseline`,
    }]
  }
  const findings: ThreatFinding[] = []
  for (const tool of advertisedTools) {
    const fp = hashToolDefinition(tool)
    const prior = known.tools[tool.name]
    if (!prior) {
      findings.push({
        risk_class: 'tool_definition_drift',
        server,
        tool: tool.name,
        detail: `tool '${tool.name}' is advertised but was not in the approved baseline`,
        observed_hash: fp.desc_hash,
      })
      continue
    }
    if (prior.desc_hash !== fp.desc_hash || prior.schema_hash !== fp.schema_hash) {
      const descChanged = prior.desc_hash !== fp.desc_hash
      findings.push({
        risk_class: 'tool_definition_drift',
        server,
        tool: tool.name,
        detail: `tool '${tool.name}' definition changed since approval`,
        baseline_hash: descChanged ? prior.desc_hash : prior.schema_hash,
        observed_hash: descChanged ? fp.desc_hash : fp.schema_hash,
      })
    }
  }
  return findings
}
