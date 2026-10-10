import * as cedar from '@cedar-policy/cedar-wasm/nodejs'
import { sha256Canonical } from '@jamjet/mcp-threat'
import type { PolicyDecision } from '@jamjet/cloud'

export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected'

/** The calling agent. Becomes the Cedar principal JamJet::Agent::"<id>". */
export interface AgentPrincipal {
  /** Agent or user identity. Default "anonymous". */
  id: string
  /** Subject type, for example "agent" or "user". Default "agent". */
  kind?: string
  /** Run identity. Default "". */
  runId?: string
  /** String claims, readable with principal.hasTag / principal.getTag. */
  tags?: Record<string, string>
}

/** One tool call to authorize. */
export interface ToolCallRequest {
  server: string
  tool: string
  args: Record<string, unknown>
  principal?: AgentPrincipal
  /** Risk label supplied by the enforcement point. Default "unknown". */
  risk?: string
  /** Hold state for this exact call. Default "none". */
  approvalStatus?: ApprovalStatus
}

/** The engine's PolicyDecision plus what Cedar decided and why. */
export interface CedarDecision extends PolicyDecision {
  source: 'cedar'
  /** Determining policy ids: satisfied forbids on deny, satisfied permits on allow. */
  policyIds: string[]
  /** Evaluation or request-validation errors. Non-empty always means block. */
  errors: string[]
  /** Human-readable explanation. */
  reason: string
}

export type InputType =
  | { kind: 'primitive' }
  | { kind: 'set'; element: InputType }
  | { kind: 'record'; attributes: Record<string, InputType> }

export interface CedarPolicySetInit {
  key: string
  policyIds: string[]
  approvalIds: Set<string>
  inputType: InputType
  warnings: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Keep only the argument attributes the schema declares. Strict validation already
// guarantees no policy can read an undeclared attribute, so dropping them cannot change
// a decision; it only stops Cedar's request validation from rejecting every call that
// carries an argument the schema does not mention. Declared attributes are passed
// through unchanged, so a wrong type still fails request validation (and blocks).
function project(value: unknown, type: InputType): unknown {
  if (type.kind === 'record') {
    if (!isPlainObject(value)) return value
    const entries: Array<[string, unknown]> = []
    for (const [name, attrType] of Object.entries(type.attributes)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) entries.push([name, project(value[name], attrType)])
    }
    // fromEntries defines own properties, so a declared "__proto__" stays data.
    return Object.fromEntries(entries)
  }
  if (type.kind === 'set') return Array.isArray(value) ? value.map((v) => project(v, type.element)) : value
  // JSON numbers past 2^53 have already lost precision in JSON.parse, so the value
  // evaluated here may differ from what the tool receives. Refuse it.
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(`integer argument ${value} is beyond the exactly representable range`)
  }
  return value
}

// The Tool entity id is "<server>___<tool>". It parses back uniquely only when the
// server has no "___" and does not end in "_". Otherwise server "a_" with tool "_b"
// and server "a" with tool "__b" would share the id "a_____b".
function serverProblem(server: string): string | null {
  if (server.length === 0) return 'server name is empty'
  if (server.includes('___')) return `server name '${server}' contains '___'`
  if (server.endsWith('_')) return `server name '${server}' ends with '_'`
  return null
}

const AGENT = 'JamJet::Agent'
const TOOL = 'JamJet::Tool'
const SERVER = 'JamJet::Server'

export class CedarPolicySet {
  readonly policyIds: readonly string[]
  readonly warnings: readonly string[]
  /** Ids of permit policies annotated @require_approval. */
  readonly approvalPolicyIds: readonly string[]
  private readonly key: string
  private readonly approvalIds: Set<string>
  private readonly inputType: InputType

  constructor(init: CedarPolicySetInit) {
    this.key = init.key
    this.policyIds = init.policyIds
    this.approvalIds = init.approvalIds
    this.approvalPolicyIds = [...init.approvalIds]
    this.inputType = init.inputType
    this.warnings = init.warnings
  }

  /** Authorize one tool call. Never throws: any failure is a block. */
  evaluate(req: ToolCallRequest): CedarDecision {
    try {
      return this.evaluateOrThrow(req)
    } catch (e) {
      return errorDecision(req.tool, [`internal error: ${(e as Error)?.message ?? String(e)}`])
    }
  }

  private evaluateOrThrow(req: ToolCallRequest): CedarDecision {
    const bad = serverProblem(req.server)
    if (bad) return errorDecision(req.tool, [bad])
    if (req.tool.length === 0) return errorDecision(req.tool, ['tool name is empty'])

    const principal = req.principal ?? { id: 'anonymous' }
    const toolId = `${req.server}___${req.tool}`
    // The JSON round trip turns anything that is not plain JSON (BigInt, functions,
    // cycles) into a thrown error, which evaluate() maps to a block.
    const context = JSON.parse(
      JSON.stringify({
        args_digest: sha256Canonical(req.args),
        risk: req.risk ?? 'unknown',
        approval_status: req.approvalStatus ?? 'none',
        input: project(req.args, this.inputType),
      }),
    ) as Record<string, cedar.CedarValueJson>
    const tags = JSON.parse(JSON.stringify(principal.tags ?? {})) as Record<string, cedar.CedarValueJson>

    const answer = cedar.statefulIsAuthorized({
      principal: { type: AGENT, id: principal.id },
      action: { type: 'JamJet::Action', id: 'call_tool' },
      resource: { type: TOOL, id: toolId },
      context,
      preparsedPolicySetId: this.key,
      preparsedSchemaName: this.key,
      validateRequest: true,
      entities: [
        {
          uid: { type: AGENT, id: principal.id },
          attrs: { kind: principal.kind ?? 'agent', run_id: principal.runId ?? '' },
          parents: [],
          tags,
        },
        {
          uid: { type: TOOL, id: toolId },
          attrs: { name: req.tool, server: req.server },
          parents: [{ type: SERVER, id: req.server }],
        },
        { uid: { type: SERVER, id: req.server }, attrs: {}, parents: [] },
      ],
    })

    if (answer.type !== 'success') return errorDecision(req.tool, answer.errors.map((e) => e.message))
    const { decision, diagnostics } = answer.response
    // Cedar skips a policy whose evaluation errors. A skipped forbid would turn into an
    // allow, so any evaluation error blocks the call.
    if (diagnostics.errors.length > 0) {
      return errorDecision(
        req.tool,
        diagnostics.errors.map((e) => `policy '${e.policyId}': ${e.error.message}`),
      )
    }
    const ids = [...diagnostics.reason].sort()
    if (decision !== 'allow') {
      return {
        source: 'cedar',
        blocked: true,
        policyKind: 'block',
        pattern: ids.length > 0 ? `cedar:${ids.join(',')}` : 'cedar:default-deny',
        toolName: req.tool,
        policyIds: ids,
        errors: [],
        reason: ids.length > 0 ? `forbidden by Cedar policy ${ids.join(', ')}` : 'no Cedar permit policy applies (default deny)',
      }
    }
    if (ids.length === 0) {
      // An allow always has at least one satisfied permit; anything else is not understood.
      return errorDecision(req.tool, ['Cedar returned allow with no determining policy'])
    }
    const approval = ids.filter((id) => this.approvalIds.has(id))
    if (approval.length > 0) {
      return {
        source: 'cedar',
        blocked: false,
        policyKind: 'require_approval',
        pattern: `cedar:${approval.join(',')}`,
        toolName: req.tool,
        policyIds: ids,
        errors: [],
        reason: `permitted by Cedar policy ${ids.join(', ')}; approval required by ${approval.join(', ')}`,
      }
    }
    return {
      source: 'cedar',
      blocked: false,
      policyKind: 'allow',
      pattern: `cedar:${ids.join(',')}`,
      toolName: req.tool,
      policyIds: ids,
      errors: [],
      reason: `permitted by Cedar policy ${ids.join(', ')}`,
    }
  }
}

function errorDecision(tool: string, errors: string[]): CedarDecision {
  return {
    source: 'cedar',
    blocked: true,
    policyKind: 'block',
    pattern: 'cedar:error',
    toolName: tool,
    policyIds: [],
    errors,
    reason: `Cedar evaluation failed, failing closed: ${errors.join('; ')}`,
  }
}
