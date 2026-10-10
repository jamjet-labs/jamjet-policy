import type { PolicyDecision } from '@jamjet/cloud'

export type CombinedSource = 'yaml' | 'cedar'

export interface CombinedDecision extends PolicyDecision {
  /** Which engine produced the winning decision. */
  source: CombinedSource
}

// Strictness order. Deny wins, then a hold, then audit, then allow.
const RANK: Record<string, number> = { allow: 0, audit: 1, require_approval: 2, block: 3 }

function rank(d: PolicyDecision): number {
  const r = Object.prototype.hasOwnProperty.call(RANK, d.policyKind) ? RANK[d.policyKind] : undefined
  // An unrecognized kind ranks as a block: it must never authorize.
  return r === undefined ? RANK.block! : r
}

/**
 * Compose a YAML rule decision with a Cedar decision. The stricter outcome wins
 * (block > require_approval > audit > allow), so neither engine can loosen the other.
 * With no Cedar policy set loaded (cedar === null) the YAML decision stands alone.
 */
export function combineDecisions(yaml: PolicyDecision, cedar: PolicyDecision | null): CombinedDecision {
  const y = normalize(yaml)
  if (cedar === null) return { ...y, source: 'yaml' }
  const c = normalize(cedar)
  const ry = rank(y)
  const rc = rank(c)
  if (rc > ry) return { ...c, source: 'cedar' }
  if (ry > rc) return { ...y, source: 'yaml' }
  // Same outcome: report the YAML rule if one matched, else the Cedar policies.
  return y.pattern !== null ? { ...y, source: 'yaml' } : { ...c, source: 'cedar' }
}

function normalize(d: PolicyDecision): PolicyDecision {
  if (Object.prototype.hasOwnProperty.call(RANK, d.policyKind)) {
    return { blocked: d.policyKind === 'block', policyKind: d.policyKind, pattern: d.pattern, toolName: d.toolName }
  }
  return { blocked: true, policyKind: 'block', pattern: d.pattern, toolName: d.toolName }
}
