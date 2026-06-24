import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy } from '@jamjet/cloud/node'
import type { AuthzAction, PolicyVerdict } from './types.js'

export function buildEvaluator(policyPath?: string): PolicyEvaluator {
  const policy = loadPolicy(policyPath)
  const evaluator = new PolicyEvaluator()
  for (const rule of policy.rules) evaluator.add(rule.action, rule.match)
  return evaluator
}

export function decidePolicy(evaluator: PolicyEvaluator, action: AuthzAction): PolicyVerdict {
  const d = evaluator.evaluate(action.tool)
  switch (d.policyKind) {
    case 'block':
      return { kind: 'BLOCK', matchedPattern: d.pattern, reason: `tool '${action.tool}' matches blocked pattern '${d.pattern ?? '*'}'` }
    case 'require_approval':
      return { kind: 'PENDING', matchedPattern: d.pattern }
    default:
      return { kind: 'ALLOW', matchedPattern: d.pattern }
  }
}
