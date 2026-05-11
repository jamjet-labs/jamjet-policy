import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy, AuditWriter } from '@jamjet/cloud/node'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface JamjetGuardrailOptions {
  /** Path to policy.yaml. If omitted, uses the canonical lookup order. */
  policy?: string
  /** Override the audit destination. Defaults to ~/.jamjet/audit/. */
  auditDestination?: string
}

export interface GuardrailInput {
  toolName: string
  toolArgs: Record<string, unknown>
}

export class JamjetPolicyBlocked extends Error {
  constructor(public readonly tool: string, public readonly rule: string | null) {
    super(`JamJet policy: BLOCKED (tool: ${tool}, rule: ${rule ?? 'unknown'})`)
    this.name = 'JamjetPolicyBlocked'
  }
}

export class JamjetApprovalRequired extends Error {
  constructor(public readonly tool: string, public readonly rule: string | null) {
    super(`JamJet policy: WAITING_FOR_APPROVAL (tool: ${tool}, rule: ${rule ?? 'unknown'})`)
    this.name = 'JamjetApprovalRequired'
  }
}

/**
 * Build a JamJet guardrail callable compatible with the OpenAI Agents SDK
 * `inputGuardrails` API.
 *
 * @example
 *   import { tool } from 'openai-agents'
 *   import { jamjetGuardrail } from '@jamjet/openai-guardrail'
 *
 *   const refund = tool({
 *     name: 'payments.refund',
 *     inputGuardrails: [jamjetGuardrail({ policy: '~/.jamjet/policy.yaml' })],
 *     execute: refundCustomer,
 *   })
 */
export function jamjetGuardrail(
  options: JamjetGuardrailOptions = {},
): (input: GuardrailInput) => void {
  const resolvedPolicyPath = options.policy?.startsWith('~')
    ? join(homedir(), options.policy.slice(1).replace(/^[\\/]+/, ''))
    : options.policy
  const policy = loadPolicy(resolvedPolicyPath)
  const evaluator = new PolicyEvaluator()
  for (const r of policy.rules) evaluator.add(r.action, r.match)

  const auditDir =
    options.auditDestination ??
    policy.audit?.destination?.replace(/^~/, homedir()) ??
    join(homedir(), '.jamjet', 'audit')
  const audit = new AuditWriter({ destination: auditDir, adapter: 'openai-guardrail' })

  return function jamjetInputGuardrail(input: GuardrailInput): void {
    const d = evaluator.evaluate(input.toolName)

    let decision: 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'ALLOWED' | 'AUDIT'
    let rule_kind: 'allow' | 'block' | 'require_approval' | 'audit' | null
    let executed: boolean

    if (d.blocked) {
      decision = 'BLOCKED'
      rule_kind = 'block'
      executed = false
    } else if (d.policyKind === 'require_approval') {
      decision = 'WAITING_FOR_APPROVAL'
      rule_kind = 'require_approval'
      executed = false
    } else if (d.policyKind === 'audit') {
      decision = 'AUDIT'
      rule_kind = 'audit'
      executed = true
    } else {
      decision = 'ALLOWED'
      rule_kind = d.pattern ? 'allow' : null
      executed = true
    }

    audit.write({
      run_id: `run_${randomBytes(6).toString('hex')}`,
      host: 'openai-agents-sdk',
      tool: input.toolName,
      args: input.toolArgs,
      decision,
      rule: d.pattern,
      rule_kind,
      executed,
    })

    if (decision === 'BLOCKED') {
      throw new JamjetPolicyBlocked(input.toolName, d.pattern)
    }
    if (decision === 'WAITING_FOR_APPROVAL') {
      // v0.1: surface as a runtime error. v0.2 will integrate with the
      // OpenAI Agents SDK approval API + JamJet ApprovalQueue.
      throw new JamjetApprovalRequired(input.toolName, d.pattern)
    }
  }
}
