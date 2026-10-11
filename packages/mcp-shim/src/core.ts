/**
 * The shim's message logic, separated from stdio so it can be tested directly.
 *
 * Client -> server: identity check, protocol version check, deprecated-feature
 * check, then tools/call governance (tool pins, policy, threat controls).
 * Server -> client: protocol checks on initialize / server/discover results,
 * tool pinning on tools/list results, deprecated-feature checks, and refusal of
 * server-initiated requests once the client has shown it speaks 2026-07-28.
 */
import type { PolicyEvaluator } from '@jamjet/cloud'
import {
  evaluateToolsList,
  evaluateCall,
  strictest,
  type Decision,
  type ThreatConfig,
  type ThreatFinding,
  type TrustBaseline,
} from '@jamjet/mcp-threat'
import { randomBytes } from 'node:crypto'
import { resolveRequestIdentity, INVALID_REQUEST } from './routing.js'
import { caseConfusableKey, depthExceeds, idKey, isValidId } from './wire.js'
import {
  classifyClientRequestVersion,
  checkInitializeResult,
  filterDiscoverResult,
  unsupportedVersionError,
  KNOWN_VERSIONS,
  META_PROTOCOL_VERSION,
  type Era,
} from './protocol.js'
import {
  checkPin,
  findInvisibleCharacters,
  loadPinFile,
  printable,
  savePins,
  PINNED_FIELDS,
  MAX_DEFINITION_DEPTH,
  toolDefinitionHash,
  type PinEntry,
  type PinFile,
} from './tool-pins.js'
import { classifyDeprecated, deprecatedInputRequests, type Direction } from './deprecations.js'
import type { DeprecatedFeature, ShimMcpConfig } from './shim-config.js'
import { interceptToolsCall, blockResponse } from './tools-call.js'
import { traceIdFromMcpRequest } from './cloud-push.js'

type Id = number | string

/** JamJet's implementation-defined error code (spec reserves -32000..-32019 for implementations). */
export const JAMJET_POLICY_ERROR = -32000
export const METHOD_NOT_FOUND = -32601
const MAX_PREFETCH_PAGES = 50
const INTERNAL_ERROR = -32603
/** Deeper messages are refused before any recursive code (hashing, serialisation) sees them. */
export const MAX_MESSAGE_DEPTH = 256
/** First-sight pins per process; a server cannot grow the pin file without bound. */
export const MAX_FIRST_SIGHT_PINS = 500
const JSONRPC_MEMBERS = ['jsonrpc', 'id', 'method', 'params', 'result', 'error'] as const
const PARAM_MEMBERS = ['name', 'arguments', 'uri', 'cursor', '_meta', 'protocolVersion', 'capabilities', 'clientInfo'] as const
const COMMON_RESULT_MEMBERS = ['resultType', 'inputRequests', 'requestState', '_meta'] as const
const RESULT_MEMBERS: Record<string, readonly string[]> = {
  'tools/list': [...COMMON_RESULT_MEMBERS, 'tools', 'nextCursor', 'ttlMs', 'cacheScope'],
  'initialize': [...COMMON_RESULT_MEMBERS, 'protocolVersion', 'capabilities', 'serverInfo', 'instructions'],
  'server/discover': [...COMMON_RESULT_MEMBERS, 'supportedVersions', 'capabilities', 'instructions', 'ttlMs', 'cacheScope'],
}
const TOOL_MEMBERS = [...PINNED_FIELDS, 'icons', '_meta'] as const

export type PinBlockReason =
  | 'tool_definition_changed'
  | 'tool_not_pinned'
  | 'invisible_unicode'
  | 'duplicate_tool_definition'
  | 'tool_not_listed'
  | 'pin_file_unreadable'
  | 'ambiguous_definition'
  | 'definition_too_deep'

/** Everything a client and an operator need to understand and clear a pin block. */
export interface PinDecisionRecord {
  decision: 'BLOCKED'
  reason: PinBlockReason
  server: string
  tool: string
  detail: string
  pinned_hash?: string
  observed_hash?: string
  invisible?: Array<{ path: string; codepoint: string }>
  pins_file: string
  approve?: string
}

export interface AuditRecord {
  run_id: string
  trace_id?: string
  server: string
  tool: string
  args: Record<string, unknown>
  decision: Decision
  rule: string | null
  rule_kind: 'allow' | 'block' | 'require_approval' | 'audit' | null
  executed: boolean
}

export interface ShimCoreDeps {
  serverName: string
  evaluator: PolicyEvaluator
  config: ShimMcpConfig
  threatBaseline: TrustBaseline
  threatConfig: ThreatConfig
  toClient: (msg: unknown) => void
  toServer: (msg: unknown) => void
  log: (line: string) => void
  audit: (event: AuditRecord) => void
  receipt: (finding: ThreatFinding, decision: Decision, action: 'tools/call' | 'tools/list') => void
  approvals: {
    enqueue: (req: { tool: string; args: Record<string, unknown> }) => string
    wait: (runId: string) => Promise<{ status: 'approved' | 'rejected' }>
  }
  now?: () => string
}

interface BlockedTool {
  record: PinDecisionRecord
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function hasId(m: Record<string, unknown>): boolean {
  return typeof m.id === 'string' || typeof m.id === 'number'
}

export class ShimCore {
  private era: Era | null = null
  /** client request id -> method, to read the matching server response. */
  private pending = new Map<string, string>()
  /** tool name -> definition hash the shim accepted in this process. */
  private observed = new Map<string, string>()
  private blocked = new Map<string, BlockedTool>()
  /** First-sight pins kept in memory too, so a failed write cannot reopen the tool. */
  private sessionPins = new Map<string, string>()
  private threatFlagged = new Map<string, ThreatFinding>()
  private serverUnverified = false
  private warnedOnce = new Set<string>()
  private shimRequests = new Map<string, (res: Record<string, unknown> | null) => void>()
  private shimRequestSeq = 0
  private readonly shimIdPrefix = `jamjet-shim-${randomBytes(6).toString('hex')}-`
  private prefetchInFlight: Promise<void> | null = null
  private readonly now: () => string

  constructor(deps: ShimCoreDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    // Log lines interpolate server-supplied names and versions: escape anything
    // that could hide text or drive the operator's terminal.
    const rawLog = deps.log
    this.deps = {
      ...deps,
      log: (line) => {
        const body = line.endsWith('\n') ? line.slice(0, -1) : line
        rawLog(printable(body) + '\n')
      },
    }
  }

  private deps: ShimCoreDeps

  // -------------------------------------------------------------------------
  // client -> server
  // -------------------------------------------------------------------------

  async onClientMessage(msg: unknown): Promise<void> {
    if (!isObject(msg)) {
      // JSON-RPC batch or a non-object: never forward something the shim did not govern.
      const r = resolveRequestIdentity(msg)
      const code = r.ok ? INVALID_REQUEST : r.code
      const message = r.ok ? 'Invalid Request' : r.message
      this.deps.toClient({ jsonrpc: '2.0', id: null, error: { code, message } })
      this.deps.log(`JamJet: refused a client message that is not a single JSON-RPC object (${message})\n`)
      return
    }

    const replyId = isValidId(msg.id) ? msg.id : null
    const refuse = (message: string, id: Id | null = replyId) => {
      this.deps.toClient({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message } })
      this.deps.log(`JamJet: refused client message: ${message}\n`)
    }
    if (depthExceeds(msg, MAX_MESSAGE_DEPTH)) return refuse(`message nests deeper than ${MAX_MESSAGE_DEPTH} levels`)
    const confusable = caseConfusableKey(msg, JSONRPC_MEMBERS)
    if (confusable !== null) return refuse(`ambiguous member '${confusable}' (keys must not differ only by case)`)
    if ('id' in msg && !isValidId(msg.id)) return refuse('id must be a string or a number', null)

    // A response from the client to a legacy server-initiated request.
    if (!('method' in msg)) {
      if (replyId === null || !('result' in msg || 'error' in msg)) return refuse('message has no method and is not a response')
      this.deps.toServer(msg)
      return
    }

    if (isObject(msg.params)) {
      const p = caseConfusableKey(msg.params, PARAM_MEMBERS)
      if (p !== null) return refuse(`ambiguous params key '${p}' (keys must not differ only by case)`)
    }

    const isRequest = hasId(msg)
    if (!isRequest && !(typeof msg.method === 'string' && msg.method.startsWith('notifications/'))) {
      return refuse(`'${String(msg.method)}' is a request and needs an id`, null)
    }
    const routed = resolveRequestIdentity(msg)
    if (!routed.ok) {
      if (isRequest) this.deps.toClient({ jsonrpc: '2.0', id: msg.id, error: { code: routed.code, message: routed.message } })
      this.deps.log(`JamJet: refused client message: ${routed.message}\n`)
      return
    }
    const { method, name } = routed.identity

    if (isRequest) {
      const v = classifyClientRequestVersion(msg)
      // An unknown version offered in `initialize` is ordinary legacy negotiation:
      // the server answers with a version it supports, and that answer is what
      // inspectResponse checks. Every other request states the version it uses.
      if (v.kind === 'unknown' && method === 'initialize') {
        this.era = 'legacy'
      } else if (v.kind === 'unknown') {
        if (this.deps.config.unknownVersions === 'refuse') {
          this.deps.log(`JamJet: refused ${method}: protocol version ${JSON.stringify(v.version)} is not one the shim can govern (known: ${KNOWN_VERSIONS.join(', ')})\n`)
          this.deps.toClient(unsupportedVersionError(msg.id as Id, v.version))
          return
        }
        this.warnOnce(`version:${String(v.version)}`, `JamJet: WARNING forwarding protocol version ${JSON.stringify(v.version)} the shim does not know (mcp.protocol.unknown_versions: pass); tools/call is still policy-checked by name\n`)
      } else if (v.kind === 'known') {
        this.era = v.era
      }
    }

    if (this.deprecatedBlocked('from_client', msg)) return

    if (isRequest) this.pending.set(idKey(msg.id as Id), method)

    if (method === 'tools/call' && isRequest && name !== null) {
      await this.governToolsCall(msg, name)
      return
    }
    this.deps.toServer(msg)
  }

  private async governToolsCall(msg: Record<string, unknown>, tool: string): Promise<void> {
    const id = msg.id as Id
    const params = isObject(msg.params) ? msg.params : {}
    const args = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {}
    const trace_id = traceIdFromMcpRequest(params)

    const intercept = interceptToolsCall(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { ...params, name: tool, arguments: args } },
      this.deps.evaluator,
    )!

    // A call the policy already blocks is refused below without fetching tool
    // definitions. Every other call must pass the pin check first, which may
    // fetch tools/list and so must run before the trust-lock evaluation.
    if (intercept.decision !== 'BLOCKED') {
      const pinBlock = this.deps.config.pinning.mode !== 'off'
        ? await this.pinCheckForCall(msg, tool)
        : (this.blocked.get(tool)?.record ?? null) // pinning off: only the hidden-character check blocks
      if (pinBlock) {
        this.pending.delete(idKey(id))
        this.recordPinBlockedCall(pinBlock, args, trace_id)
        this.deps.toClient(pinBlockResponse(id, pinBlock))
        return
      }
    }

    const threat = evaluateCall({
      server: this.deps.serverName,
      tool,
      args,
      flagged: this.threatFlagged,
      serverUnverified: this.serverUnverified,
      config: this.deps.threatConfig,
    })
    const combined = strictest(intercept.decision as Decision, threat.decision.decision)
    const threatDrove = threat.decision.finding !== null &&
      threat.decision.decision === combined &&
      intercept.decision !== combined
    if (threat.decision.finding && combined !== 'ALLOWED') {
      this.deps.receipt(threat.decision.finding, combined, 'tools/call')
    }
    const rule = threatDrove ? `threat:${threat.decision.finding!.risk_class}` : intercept.rule
    const rule_kind = threatDrove ? null : intercept.rule_kind
    const executed = combined === 'ALLOWED' || combined === 'AUDIT'
    this.deps.audit({
      run_id: `run_${Date.now().toString(36)}`, trace_id,
      server: this.deps.serverName, tool, args,
      decision: combined, rule, rule_kind, executed,
    })

    if (combined === 'BLOCKED') {
      this.pending.delete(idKey(id))
      this.deps.toClient(blockResponse(id, rule))
      return
    }
    if (combined === 'WAITING_FOR_APPROVAL') {
      const runId = this.deps.approvals.enqueue({ tool, args })
      this.deps.log(`JamJet: ${tool} waiting approval, run \`jamjet approve ${runId}\`\n`)
      const result = await this.deps.approvals.wait(runId)
      if (result.status !== 'approved') {
        this.pending.delete(idKey(id))
        this.deps.toClient(blockResponse(id, rule))
        return
      }
      // The definition may have changed while a human was deciding.
      if (this.deps.config.pinning.mode !== 'off') {
        const late = await this.pinCheckForCall(msg, tool)
        if (late) {
          this.pending.delete(idKey(id))
          this.recordPinBlockedCall(late, args, trace_id)
          this.deps.toClient(pinBlockResponse(id, late))
          return
        }
      }
    }
    this.deps.toServer(msg)
  }

  /** Returns a decision record when the call must be refused for pin reasons. */
  private async pinCheckForCall(msg: Record<string, unknown>, tool: string): Promise<PinDecisionRecord | null> {
    let b = this.blocked.get(tool)
    if (b && this.tryReapprove(tool, b)) b = undefined
    if (b) return b.record
    if (this.observed.has(tool)) return null

    // The client has not listed tools through this shim (a 2026-07-28 client may
    // reuse a cached list). Verify the server's current definition first.
    await this.prefetchTools(msg)
    b = this.blocked.get(tool)
    if (b) return b.record
    if (this.observed.has(tool)) return null
    return {
      decision: 'BLOCKED', reason: 'tool_not_listed', server: this.deps.serverName, tool,
      detail: `tool '${tool}' is not in the server's tools/list, so its definition cannot be checked against a pin`,
      pins_file: this.deps.config.pinning.file,
    }
  }

  /** An operator may have approved the new hash since the block; honour it. */
  private tryReapprove(tool: string, b: BlockedTool): boolean {
    const r = b.record
    if ((r.reason !== 'tool_definition_changed' && r.reason !== 'tool_not_pinned') || !r.observed_hash) return false
    let pins: PinFile
    try {
      pins = loadPinFile(this.deps.config.pinning.file)
    } catch {
      return false
    }
    const verdict = checkPin(pins, this.deps.serverName, tool, r.observed_hash, 'allowlist')
    if (verdict.status !== 'match') return false
    this.blocked.delete(tool)
    this.observed.set(tool, r.observed_hash)
    this.deps.log(`JamJet pin: '${tool}' on ${this.deps.serverName} re-approved (${r.observed_hash})\n`)
    return true
  }

  private prefetchTools(callMsg: Record<string, unknown>): Promise<void> {
    if (this.prefetchInFlight) return this.prefetchInFlight
    const params = isObject(callMsg.params) ? callMsg.params : {}
    const callMeta = isObject(params._meta) ? params._meta : undefined
    const meta: Record<string, unknown> = {}
    if (callMeta) {
      for (const k of [META_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities', 'io.modelcontextprotocol/clientInfo']) {
        if (Object.hasOwn(callMeta, k)) meta[k] = callMeta[k]
      }
    }
    this.prefetchInFlight = (async () => {
      let cursor: unknown
      for (let page = 0; page < MAX_PREFETCH_PAGES; page++) {
        const p: Record<string, unknown> = {}
        if (Object.keys(meta).length > 0) p._meta = meta
        if (typeof cursor === 'string') p.cursor = cursor
        const res = await this.shimRequest('tools/list', p)
        if (!res || !isObject(res.result) || !Array.isArray(res.result.tools) || caseConfusableKey(res.result, RESULT_MEMBERS['tools/list']!) !== null) {
          this.deps.log(`JamJet pin: could not fetch tools/list from ${this.deps.serverName} to verify a call${res && isObject(res.error) ? ` (${String(res.error.message)})` : ' (timeout)'}\n`)
          return
        }
        this.observeToolsList(res.result.tools)
        cursor = res.result.nextCursor
        if (typeof cursor !== 'string' || cursor.length === 0) return
      }
    })().finally(() => {
      this.prefetchInFlight = null
    })
    return this.prefetchInFlight
  }

  private shimRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = `${this.shimIdPrefix}${++this.shimRequestSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.shimRequests.delete(id)
        resolve(null)
      }, this.deps.config.pinning.prefetchTimeoutMs)
      this.shimRequests.set(id, (res) => {
        clearTimeout(timer)
        this.shimRequests.delete(id)
        resolve(res)
      })
      this.deps.toServer({ jsonrpc: '2.0', id, method, params })
    })
  }

  // -------------------------------------------------------------------------
  // server -> client
  // -------------------------------------------------------------------------

  onServerMessage(msg: unknown): void {
    try {
      this.handleServerMessage(msg)
    } catch (err) {
      // Fail closed on anything unexpected from the server, but keep running.
      this.deps.log(`JamJet: dropped a server message that could not be inspected: ${(err as Error).message}\n`)
    }
  }

  private handleServerMessage(msg: unknown): void {
    if (!isObject(msg)) {
      this.deps.log('JamJet: dropped a server message that is not a single JSON-RPC object\n')
      return
    }
    const isResponse = !('method' in msg) && hasId(msg)
    const pendingKey = isResponse ? idKey(msg.id as Id) : null
    const reject = (why: string) => {
      this.deps.log(`JamJet: refused server message: ${why}\n`)
      if (pendingKey !== null && this.pending.has(pendingKey)) {
        this.pending.delete(pendingKey)
        this.deps.toClient({ jsonrpc: '2.0', id: msg.id, error: { code: INTERNAL_ERROR, message: `JamJet: refused server response (${why})` } })
      }
    }
    if (depthExceeds(msg, MAX_MESSAGE_DEPTH)) return reject(`message nests deeper than ${MAX_MESSAGE_DEPTH} levels`)
    const confusable = caseConfusableKey(msg, JSONRPC_MEMBERS)
    if (confusable !== null) return reject(`ambiguous member '${confusable}' (keys must not differ only by case)`)

    if (isResponse) {
      const id = msg.id as Id
      if (typeof id === 'string' && this.shimRequests.has(id)) {
        this.shimRequests.get(id)!(msg)
        return
      }
      // Ids are matched by type and value: "3" does not answer request 3, so a
      // server cannot route a result around the checks below.
      const method = this.pending.get(pendingKey!)
      if (method === undefined) {
        this.deps.log(`JamJet: dropped server response with id ${JSON.stringify(id)}: it does not match a pending request\n`)
        return
      }
      if (isObject(msg.result)) {
        const r = caseConfusableKey(msg.result, RESULT_MEMBERS[method] ?? COMMON_RESULT_MEMBERS)
        if (r !== null) return reject(`ambiguous result key '${r}' (keys must not differ only by case)`)
      }
      this.pending.delete(pendingKey!)
      this.deps.toClient(this.inspectResponse(method, msg))
      return
    }

    if (hasId(msg)) {
      // A server-initiated request. 2026-07-28 forbids these on stdio; they are
      // replaced by input_required results (MRTR).
      if (this.era === 'modern') {
        this.deps.log(`JamJet: refused server-initiated request '${String(msg.method)}': not allowed in protocol 2026-07-28 (servers use input_required results)\n`)
        this.deps.toServer({ jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: 'Server-initiated requests are not supported in protocol 2026-07-28' } })
        return
      }
    }

    if (msg.method === 'notifications/tools/list_changed') {
      // Definitions may have changed: verify again before the next call.
      this.observed.clear()
    }
    if (this.deprecatedBlocked('from_server', msg)) return
    this.deps.toClient(msg)
  }

  private inspectResponse(method: string | undefined, msg: Record<string, unknown>): Record<string, unknown> {
    const result = msg.result
    if (!isObject(result)) return msg

    if (method === 'initialize') {
      const check = checkInitializeResult(result)
      if (!check.ok) {
        if (this.deps.config.unknownVersions === 'refuse') {
          this.deps.log(`JamJet: refused initialize: server negotiated protocol version ${JSON.stringify(check.version)} the shim cannot govern\n`)
          return {
            jsonrpc: '2.0', id: msg.id,
            error: {
              code: -32602,
              message: `Unsupported protocol version: server negotiated ${JSON.stringify(check.version)}, which the JamJet shim cannot govern`,
              data: { supported: [...KNOWN_VERSIONS], requested: check.version },
            },
          }
        }
        this.warnOnce(`version:${String(check.version)}`, `JamJet: WARNING server negotiated protocol version ${JSON.stringify(check.version)} the shim does not know; forwarding (mcp.protocol.unknown_versions: pass)\n`)
      }
      return msg
    }

    if (method === 'server/discover' && this.deps.config.unknownVersions === 'refuse') {
      const { result: filtered, removed } = filterDiscoverResult(result)
      if (removed.length > 0) {
        this.deps.log(`JamJet: hid protocol versions ${JSON.stringify(removed)} from server/discover: the shim cannot govern them\n`)
      }
      if (filtered.supportedVersions.length === 0) {
        return unsupportedVersionError(msg.id as Id, removed)
      }
      return { ...msg, result: filtered }
    }

    if (method === 'tools/list' && Array.isArray(result.tools)) {
      const kept = this.observeToolsList(result.tools)
      return { ...msg, result: { ...result, tools: kept } }
    }

    const asked = deprecatedInputRequests(result)
    for (const { key, feature } of asked) {
      const action = this.deps.config.deprecated[feature]
      if (action === 'block') {
        this.deps.log(`JamJet: refused ${method ?? 'response'} input_required '${key}': deprecated feature '${feature}' is blocked by mcp.deprecated.${feature}\n`)
        return {
          jsonrpc: '2.0', id: msg.id,
          error: { code: JAMJET_POLICY_ERROR, message: `JamJet policy: BLOCKED (deprecated MCP feature '${feature}' requested via input_required)` },
        }
      }
      if (action === 'warn') this.warnDeprecated(feature, `input_required '${key}' in ${method ?? 'response'}`)
    }
    return msg
  }

  /**
   * Check every advertised tool against its pin and return the tools the client
   * may see. Also feeds the trust-lock drift controls from @jamjet/mcp-threat.
   */
  private observeToolsList(tools: unknown[]): unknown[] {
    const server = this.deps.serverName
    const cfg = this.deps.config

    this.observeThreat(tools)

    if (cfg.pinning.mode === 'off') {
      return tools.filter((t) => this.scanInvisibleOnly(t))
    }

    let pins: PinFile | null = null
    let pinError: string | null = null
    try {
      pins = loadPinFile(cfg.pinning.file)
    } catch (err) {
      pinError = (err as Error).message
    }

    const hashesByName = new Map<string, Set<string>>()
    for (const t of tools) {
      if (isObject(t) && typeof t.name === 'string') {
        const set = hashesByName.get(t.name) ?? new Set<string>()
        set.add(toolDefinitionHash(t))
        hashesByName.set(t.name, set)
      }
    }

    const kept: unknown[] = []
    const newPins: Array<[string, PinEntry]> = []
    for (const t of tools) {
      if (!isObject(t) || typeof t.name !== 'string') {
        this.deps.log(`JamJet pin: dropped a tools/list entry without a string name from ${server}\n`)
        continue
      }
      const name = t.name
      const hash = toolDefinitionHash(t)
      const block = (reason: PinBlockReason, detail: string, extra: Partial<PinDecisionRecord> = {}) => {
        const record: PinDecisionRecord = {
          decision: 'BLOCKED', reason, server, tool: name, detail,
          observed_hash: hash, pins_file: cfg.pinning.file, ...extra,
        }
        this.blocked.set(name, { record })
        this.observed.delete(name)
        this.deps.log(`JamJet pin: BLOCKED '${name}' on ${server}: ${detail}${record.approve ? `; to approve: ${record.approve}` : ''}\n`)
      }

      const structural = structuralProblem(t)
      if (structural) {
        block(structural.reason, structural.detail)
        continue
      }
      if (pinError !== null) {
        block('pin_file_unreadable', `pin file ${cfg.pinning.file} cannot be read: ${pinError}`)
        continue
      }
      if (hashesByName.get(name)!.size > 1) {
        block('duplicate_tool_definition', `server advertised '${name}' more than once with different definitions`)
        continue
      }

      const invisible = findInvisibleCharacters(t)
      if (invisible.length > 0) {
        const where = invisible.slice(0, 5).map((f) => `${f.codepoint} at ${f.path}`).join(', ')
        if (cfg.invisibleUnicode === 'block') {
          block('invisible_unicode', `definition contains invisible or control characters (${where})`, { invisible })
          continue
        }
        this.deps.log(`JamJet pin: WARNING '${name}' on ${server} contains invisible or control characters (${where})\n`)
      }

      const sessionHash = this.sessionPins.get(name)
      let verdict = checkPin(pins!, server, name, hash, cfg.pinning.mode)
      if (verdict.status === 'first_sight' && sessionHash !== undefined) {
        verdict = sessionHash === hash ? { status: 'match' } : { status: 'changed', pinned_hash: sessionHash, observed_hash: hash }
      }

      if (verdict.status === 'changed') {
        block('tool_definition_changed', `definition changed since it was pinned (pinned ${verdict.pinned_hash}, now ${hash})`, {
          pinned_hash: verdict.pinned_hash,
          approve: approveCommand(server, name, hash, cfg.pinning.file),
        })
        this.deps.receipt({
          risk_class: 'tool_definition_drift', server, tool: name,
          detail: `tool '${name}' definition changed since it was pinned`,
          baseline_hash: verdict.pinned_hash, observed_hash: hash,
        }, 'BLOCKED', 'tools/list')
        continue
      }
      if (verdict.status === 'not_pinned') {
        block('tool_not_pinned', `tool is not in the pinned allowlist ${cfg.pinning.file}`, {
          approve: approveCommand(server, name, hash, cfg.pinning.file),
        })
        this.deps.receipt({
          risk_class: 'first_seen', server, tool: name,
          detail: `tool '${name}' is not in the pinned allowlist`, observed_hash: hash,
        }, 'BLOCKED', 'tools/list')
        continue
      }
      if (verdict.status === 'first_sight') {
        if (this.sessionPins.size >= MAX_FIRST_SIGHT_PINS) {
          block('tool_not_pinned', `first-sight pin limit (${MAX_FIRST_SIGHT_PINS} per process) reached; approve this tool explicitly`, {
            approve: approveCommand(server, name, hash, cfg.pinning.file),
          })
          continue
        }
        this.sessionPins.set(name, hash)
        newPins.push([name, { hash, pinned_at: this.now(), source: 'first_sight' }])
      }
      this.blocked.delete(name)
      this.observed.set(name, hash)
      kept.push(t)
    }

    if (newPins.length > 0) {
      try {
        savePins(cfg.pinning.file, server, newPins)
        this.deps.log(`JamJet pin: pinned ${newPins.length} tool(s) on ${server} on first sight: ${newPins.map(([n]) => n).join(', ')}\n`)
      } catch (err) {
        this.deps.log(`JamJet pin: WARNING could not write ${newPins.length} pin(s) (${(err as Error).message}); pinned for this process only\n`)
      }
    }
    return kept
  }

  /** With pinning off, the invisible-character check still runs. */
  private scanInvisibleOnly(t: unknown): boolean {
    if (!isObject(t) || typeof t.name !== 'string') return true
    const structural = structuralProblem(t)
    if (structural) {
      this.deps.log(`JamJet pin: BLOCKED '${t.name}' on ${this.deps.serverName}: ${structural.detail}\n`)
      this.blocked.set(t.name, {
        record: {
          decision: 'BLOCKED', reason: structural.reason, server: this.deps.serverName, tool: t.name,
          detail: structural.detail, pins_file: this.deps.config.pinning.file,
        },
      })
      return false
    }
    const invisible = findInvisibleCharacters(t)
    if (invisible.length === 0) return true
    const where = invisible.slice(0, 5).map((f) => `${f.codepoint} at ${f.path}`).join(', ')
    if (this.deps.config.invisibleUnicode === 'warn') {
      this.deps.log(`JamJet pin: WARNING '${t.name}' on ${this.deps.serverName} contains invisible or control characters (${where})\n`)
      return true
    }
    this.deps.log(`JamJet pin: BLOCKED '${t.name}' on ${this.deps.serverName}: definition contains invisible or control characters (${where})\n`)
    this.blocked.set(t.name, {
      record: {
        decision: 'BLOCKED', reason: 'invisible_unicode', server: this.deps.serverName, tool: t.name,
        detail: `definition contains invisible or control characters (${where})`,
        observed_hash: toolDefinitionHash(t), invisible, pins_file: this.deps.config.pinning.file,
      },
    })
    return false
  }

  private observeThreat(tools: unknown[]): void {
    try {
      const defs = tools
        .filter((t): t is Record<string, unknown> => isObject(t) && typeof t.name === 'string')
        .map((t) => ({ name: t.name as string, description: t.description as string | undefined, inputSchema: t.inputSchema }))
      const evalResult = evaluateToolsList(this.deps.serverName, defs, this.deps.threatBaseline, this.deps.threatConfig)
      this.serverUnverified = evalResult.serverUnverified
      // Merge per tool rather than clearing: a later page or a later list that
      // omits a drifted tool must not erase its flag.
      for (const d of defs) {
        const f = evalResult.flagged.get(d.name)
        if (f) this.threatFlagged.set(d.name, f)
        else this.threatFlagged.delete(d.name)
      }
      if (evalResult.decision.finding) {
        this.deps.receipt(evalResult.decision.finding, evalResult.decision.decision, 'tools/list')
        this.deps.log(`JamJet threat: ${evalResult.decision.finding.risk_class} on ${this.deps.serverName} (${evalResult.decision.decision})\n`)
      }
    } catch (err) {
      this.deps.log(`JamJet threat: tools/list evaluation error (pins still enforced): ${(err as Error).message}\n`)
    }
  }

  // -------------------------------------------------------------------------
  // deprecated features
  // -------------------------------------------------------------------------

  /** Returns true when the message was refused and must not be forwarded. */
  private deprecatedBlocked(direction: Direction, msg: Record<string, unknown>): boolean {
    const feature = classifyDeprecated(direction, msg)
    if (!feature) return false
    const action = this.deps.config.deprecated[feature]
    const method = String(msg.method)
    if (action === 'pass') return false
    if (action === 'warn') {
      this.warnDeprecated(feature, method)
      return false
    }
    this.deps.log(`JamJet: refused '${method}': deprecated MCP feature '${feature}' is blocked by mcp.deprecated.${feature}\n`)
    if (hasId(msg)) {
      const err = { jsonrpc: '2.0', id: msg.id, error: { code: JAMJET_POLICY_ERROR, message: `JamJet policy: BLOCKED (deprecated MCP feature '${feature}')` } }
      if (direction === 'from_server') this.deps.toServer(err)
      else this.deps.toClient(err)
    }
    return true
  }

  private warnDeprecated(feature: DeprecatedFeature, what: string): void {
    const line = `JamJet: WARNING ${what} uses '${feature}', deprecated in MCP 2026-07-28 (SEP-2577)\n`
    if (feature === 'sampling') this.deps.log(line)
    else this.warnOnce(`deprecated:${feature}`, line)
  }

  private warnOnce(key: string, line: string): void {
    if (this.warnedOnce.has(key)) return
    this.warnedOnce.add(key)
    this.deps.log(line)
  }

  private recordPinBlockedCall(record: PinDecisionRecord, args: Record<string, unknown>, trace_id: string | undefined): void {
    this.deps.audit({
      run_id: `run_${Date.now().toString(36)}`, trace_id,
      server: record.server, tool: record.tool, args,
      decision: 'BLOCKED', rule: `pin:${record.reason}`, rule_kind: null, executed: false,
    })
  }

  /** For tests and diagnostics. */
  get currentEra(): Era | null {
    return this.era
  }
}

/** Definitions another parser could read differently, or too deep to scan, are refused. */
function structuralProblem(t: Record<string, unknown>): { reason: PinBlockReason; detail: string } | null {
  const k = caseConfusableKey(t, TOOL_MEMBERS)
  if (k !== null) return { reason: 'ambiguous_definition', detail: `definition has key '${k}' that differs from another field only by case` }
  if (depthExceeds(t, MAX_DEFINITION_DEPTH)) {
    return { reason: 'definition_too_deep', detail: `definition nests deeper than ${MAX_DEFINITION_DEPTH} levels` }
  }
  return null
}

export function approveCommand(server: string, tool: string, hash: string, pinsFile: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return `jamjet-mcp-shim pins approve --server ${q(server)} --tool ${q(tool)} --hash ${hash} --pins ${q(pinsFile)}`
}

export function pinBlockResponse(id: Id, record: PinDecisionRecord) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: {
      code: JAMJET_POLICY_ERROR,
      message: `JamJet tool pin: BLOCKED (${record.reason}: ${record.tool})`,
      data: { jamjet: record },
    },
  }
}
