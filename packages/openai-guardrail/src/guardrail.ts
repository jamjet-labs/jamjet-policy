import {
  CloudPusher,
  PolicyEvaluator,
  detectPathMode,
  readTraceparent,
  type CloudPusherEvent,
} from '@jamjet/cloud'
import { loadPolicy, AuditWriter } from '@jamjet/cloud/node'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface JamjetGuardrailOptions {
  /** Path to policy.yaml. If omitted, uses the canonical lookup order. */
  policy?: string
  /** Override the audit destination. Defaults to ~/.jamjet/audit/. */
  auditDestination?: string
  /** Inject a CloudPusher (skips env-driven Path B detection). For tests. */
  cloudPusher?: CloudPusher | null
  /** Default header source for trace_id propagation (per-call headers win). */
  headers?: Record<string, string | string[] | undefined>
  /** Args redaction for events that leave the host. Defaults to env or 'full'. */
  argsRedaction?: 'full' | 'hash' | 'none'
}

export interface GuardrailInput {
  toolName: string
  toolArgs: Record<string, unknown>
  /** Optional W3C trace-context source for this call. */
  headers?: Record<string, string | string[] | undefined>
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

type ArgsRedactionMode = 'full' | 'hash' | 'none'

function resolveArgsRedaction(explicit?: ArgsRedactionMode): ArgsRedactionMode {
  if (explicit) return explicit
  const env = (process.env.JAMJET_ARGS_REDACTION ?? '').toLowerCase()
  if (env === 'full' || env === 'hash' || env === 'none') return env
  return 'full'
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

function redactArgs(
  args: Record<string, unknown>,
  mode: ArgsRedactionMode,
): { args: Record<string, unknown>; args_redaction: ArgsRedactionMode } {
  if (mode === 'none') return { args, args_redaction: 'none' }
  if (mode === 'full') return { args: { redacted: true }, args_redaction: 'full' }
  const sha256 = createHash('sha256').update(stableStringify(args)).digest('hex')
  return { args: { redacted: true, sha256 }, args_redaction: 'hash' }
}

function buildCloudPusher(): CloudPusher | null {
  if (detectPathMode() !== 'direct') return null
  const apiKey = process.env.JAMJET_CLOUD_TOKEN
  if (!apiKey) return null
  return new CloudPusher({
    apiBase: process.env.JAMJET_API_BASE ?? 'https://api.jamjet.dev',
    apiKey,
  })
}

/**
 * Build a JamJet guardrail callable compatible with the OpenAI Agents SDK
 * `inputGuardrails` API.
 *
 * Cloud Sync v0.1 (Path B): when JAMJET_CLOUD_TOKEN + a serverless heuristic
 * (or explicit JAMJET_CLOUD_MODE=direct) is set, each event is also POSTed
 * to Cloud's /v1/policy-audit/events (fire-and-forget, args redacted per
 * JAMJET_ARGS_REDACTION before leaving the host). Local JSONL keeps the
 * full args verbatim — the daemon (Path A) handles its own redaction.
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

  const pusher = options.cloudPusher === undefined ? buildCloudPusher() : options.cloudPusher
  const argsRedactionMode = resolveArgsRedaction(options.argsRedaction)
  const factoryHeaders = options.headers

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

    // Per-call headers override the factory default for trace propagation.
    const headers = input.headers ?? factoryHeaders
    const traceparent = readTraceparent({ headers })
    const trace_id = traceparent?.trace_id

    const run_id = `run_${randomBytes(6).toString('hex')}`
    audit.write({
      run_id,
      trace_id,
      host: 'openai-agents-sdk',
      tool: input.toolName,
      args: input.toolArgs,
      decision,
      rule: d.pattern,
      rule_kind,
      executed,
    })

    // Path B direct-push: send a redacted copy to Cloud. Fire-and-forget;
    // CloudPusher.push() never throws.
    if (pusher) {
      const { args: redactedArgs, args_redaction } = redactArgs(
        input.toolArgs,
        argsRedactionMode,
      )
      const event: CloudPusherEvent = {
        ts: new Date().toISOString(),
        run_id,
        adapter: 'openai-guardrail',
        host: 'openai-agents-sdk',
        tool: input.toolName,
        decision,
        executed,
        schema_version: 1,
        args: redactedArgs,
        args_redaction,
        trace_id: trace_id ?? null,
        rule: d.pattern ?? null,
        rule_kind,
      }
      void pusher.push(event).catch(() => {})
    }

    if (decision === 'BLOCKED') {
      throw new JamjetPolicyBlocked(input.toolName, d.pattern)
    }
    if (decision === 'WAITING_FOR_APPROVAL') {
      throw new JamjetApprovalRequired(input.toolName, d.pattern)
    }
  }
}
