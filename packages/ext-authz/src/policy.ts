import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy } from '@jamjet/cloud/node'
import { combineDecisions, loadCedarPoliciesFromFiles, type ApprovalStatus, type CedarPolicySet } from '@jamjet/cedar'
import type { AuthzAction, PolicyVerdict } from './types.js'

export function buildEvaluator(policyPath?: string): PolicyEvaluator {
  const policy = loadPolicy(policyPath)
  const evaluator = new PolicyEvaluator()
  for (const rule of policy.rules) evaluator.add(rule.action, rule.match)
  return evaluator
}

/** Load and validate a Cedar policy set. Throws CedarLoadError; callers must not start without it. */
export function buildCedar(policyPath: string, inputSchemaPath?: string): CedarPolicySet {
  return loadCedarPoliciesFromFiles(policyPath, inputSchemaPath)
}

export interface CedarInput {
  policies: CedarPolicySet | null | undefined
  /** Hold state for this exact action, from the hold store. Never from the request. */
  approvalStatus: ApprovalStatus
}

export function decidePolicy(evaluator: PolicyEvaluator, action: AuthzAction, cedar?: CedarInput): PolicyVerdict {
  const yaml = evaluator.evaluate(action.tool)
  const cedarDecision = cedar?.policies
    ? cedar.policies.evaluate({
        server: action.server,
        tool: action.tool,
        args: action.args,
        principal: action.principal,
        risk: action.risk,
        approvalStatus: cedar.approvalStatus,
      })
    : null
  const d = combineDecisions(yaml, cedarDecision)
  switch (d.policyKind) {
    case 'block': {
      const reason =
        d.source === 'cedar' && cedarDecision
          ? cedarDecision.reason
          : `tool '${action.tool}' matches blocked pattern '${d.pattern ?? '*'}'`
      return { kind: 'BLOCK', matchedPattern: d.pattern, reason }
    }
    case 'require_approval':
      return { kind: 'PENDING', matchedPattern: d.pattern }
    case 'allow':
    case 'audit':
      // 'allow' (including the no-rule-matched default) and 'audit' both resolve to
      // ALLOW. A receipt is emitted for every decision by the handler, so 'audit'
      // (allow + record) is satisfied by the always-on receipt; there is no separate
      // audit verdict.
      return { kind: 'ALLOW', matchedPattern: d.pattern }
    default:
      // Fail closed: an unrecognized policyKind (a future @jamjet/cloud action or a
      // typo) must never silently authorize. Block it.
      return { kind: 'BLOCK', matchedPattern: d.pattern, reason: `unrecognized policy kind '${String(d.policyKind)}' — failing closed` }
  }
}
