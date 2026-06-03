import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { ThreatAction, ThreatConfig } from './types.js'

export const THREAT_DEFAULTS: ThreatConfig = {
  on_first_seen: 'require_approval',
  on_definition_drift: 'block',
  on_tool_shadow: 'block',
  on_token_passthrough: 'block',
}

const VALID_ACTIONS: ReadonlySet<ThreatAction> = new Set(['block', 'require_approval', 'audit', 'allow'])

function coerce(value: unknown, fallback: ThreatAction): ThreatAction {
  return typeof value === 'string' && VALID_ACTIONS.has(value as ThreatAction) ? (value as ThreatAction) : fallback
}

export function parseThreatConfig(policy: unknown): ThreatConfig {
  const threat = (policy as { threat?: Record<string, unknown> } | null)?.threat ?? {}
  return {
    on_first_seen: coerce(threat.on_first_seen, THREAT_DEFAULTS.on_first_seen),
    on_definition_drift: coerce(threat.on_definition_drift, THREAT_DEFAULTS.on_definition_drift),
    on_tool_shadow: coerce(threat.on_tool_shadow, THREAT_DEFAULTS.on_tool_shadow),
    on_token_passthrough: coerce(threat.on_token_passthrough, THREAT_DEFAULTS.on_token_passthrough),
  }
}

/** Read the threat block from a policy file; defaults if missing/unreadable. */
export function loadThreatConfig(policyPath?: string): ThreatConfig {
  if (!policyPath) return { ...THREAT_DEFAULTS }
  try {
    return parseThreatConfig(parse(readFileSync(policyPath, 'utf-8')))
  } catch {
    return { ...THREAT_DEFAULTS }
  }
}
