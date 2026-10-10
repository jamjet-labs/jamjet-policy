/**
 * Request identity for policy decisions.
 *
 * MCP 2026-07-28 mirrors the JSON-RPC `method` and the target name into the
 * `Mcp-Method` / `Mcp-Name` HTTP headers so gateways can route without parsing
 * the body. A gateway that routes or authorizes on the header while the server
 * executes the body can be steered by a request whose header and body disagree.
 *
 * Rule here: the body is the only source of identity, because the body is what
 * the server executes. Headers, when a transport supplies them, are validated
 * against the body and any disagreement refuses the request (HeaderMismatch,
 * -32020). On stdio there is no header layer (spec, stdio "Request Metadata"),
 * so callers pass no headers and identity comes from the body alone.
 */

export const INVALID_REQUEST = -32600
export const INVALID_PARAMS = -32602
export const HEADER_MISMATCH = -32020

const FIRST_MODERN_VERSION = '2026-07-28'
const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'

/** Methods whose target name is mirrored into `Mcp-Name`, and where it lives in params. */
const NAME_FIELD: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

export interface RequestIdentity {
  method: string
  /** Tool or prompt name, or resource URI; null for methods with no target. */
  name: string | null
}

export type RoutingResult =
  | { ok: true; identity: RequestIdentity }
  | { ok: false; code: number; message: string }

export type HeaderBag = Record<string, string | string[] | undefined>

const SENTINEL = /^=\?base64\?([^?]*)\?=$/
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// RFC 9110 field-value characters as the MCP spec restates them: VCHAR, SP, HTAB.
const HEADER_SAFE = /^[\t\x20-\x7e]*$/

/** Decode an `Mcp-Name` / `Mcp-Param-*` value. Returns null when the sentinel is malformed. */
export function decodeHeaderValue(value: string): string | null {
  const m = SENTINEL.exec(value)
  if (!m) return value
  const b64 = m[1]!
  if (!STRICT_BASE64.test(b64)) return null
  return Buffer.from(b64, 'base64').toString('utf-8')
}

/** `value` is the first occurrence; `multi` marks a repeated header, which is refused. */
function headerLookup(headers: HeaderBag, name: string): { present: boolean; value?: string; multi?: boolean } {
  const want = name.toLowerCase()
  const values: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want || v === undefined) continue
    if (Array.isArray(v)) values.push(...v)
    else values.push(v)
  }
  if (values.length === 0) return { present: false }
  return { present: true, value: values[0], multi: values.length > 1 }
}

function mismatch(message: string): RoutingResult {
  return { ok: false, code: HEADER_MISMATCH, message: `Header mismatch: ${message}` }
}

function bodyProtocolVersion(params: Record<string, unknown> | undefined): string | undefined {
  const meta = params?._meta
  if (!meta || typeof meta !== 'object') return undefined
  const v = (meta as Record<string, unknown>)[META_VERSION_KEY]
  return typeof v === 'string' ? v : undefined
}

function isModernVersion(v: string | undefined): boolean {
  // Protocol versions are ISO dates, so string order is date order.
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= FIRST_MODERN_VERSION
}

/**
 * Resolve the method and target name a policy decision must use.
 * Pass `headers` only when the transport has a header layer (HTTP).
 */
export function resolveRequestIdentity(msg: unknown, headers?: HeaderBag): RoutingResult {
  if (Array.isArray(msg)) {
    return { ok: false, code: INVALID_REQUEST, message: 'JSON-RPC batches are not supported by the JamJet shim' }
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, code: INVALID_REQUEST, message: 'Invalid Request: message is not a JSON object' }
  }
  const m = msg as { method?: unknown; params?: unknown }
  if (typeof m.method !== 'string') {
    return { ok: false, code: INVALID_REQUEST, message: 'Invalid Request: method must be a string' }
  }
  const method = m.method
  const params = m.params && typeof m.params === 'object' && !Array.isArray(m.params)
    ? (m.params as Record<string, unknown>)
    : undefined

  let name: string | null = null
  const field = NAME_FIELD[method]
  if (field) {
    const raw = params?.[field]
    if (typeof raw !== 'string') {
      return { ok: false, code: INVALID_PARAMS, message: `Invalid params: ${method} requires a string params.${field}` }
    }
    name = raw
  }

  if (headers === undefined) return { ok: true, identity: { method, name } }

  const hMethod = headerLookup(headers, 'Mcp-Method')
  const hName = headerLookup(headers, 'Mcp-Name')
  const hVersion = headerLookup(headers, 'MCP-Protocol-Version')
  for (const [label, h] of [['Mcp-Method', hMethod], ['Mcp-Name', hName], ['MCP-Protocol-Version', hVersion]] as const) {
    if (h.multi) return mismatch(`${label} header appears more than once`)
    if (h.present && !HEADER_SAFE.test(h.value ?? '')) return mismatch(`${label} header contains invalid characters`)
  }

  const bodyVersion = bodyProtocolVersion(params)
  if (hVersion.present && bodyVersion !== undefined && hVersion.value !== bodyVersion) {
    return mismatch(`MCP-Protocol-Version header '${hVersion.value}' does not match body version '${bodyVersion}'`)
  }
  const modern = isModernVersion(bodyVersion) || isModernVersion(hVersion.value)

  if (hMethod.present) {
    if (hMethod.value !== method) {
      return mismatch(`Mcp-Method header value '${hMethod.value}' does not match body method '${method}'`)
    }
  } else if (modern) {
    return mismatch('required Mcp-Method header is missing')
  }

  if (hName.present) {
    if (name === null) return mismatch(`Mcp-Name header is not valid for method '${method}'`)
    const decoded = decodeHeaderValue(hName.value ?? '')
    if (decoded === null) return mismatch('Mcp-Name header has a malformed base64 value')
    if (decoded !== name) {
      return mismatch(`Mcp-Name header value '${hName.value}' does not match body value '${name}'`)
    }
  } else if (modern && name !== null) {
    return mismatch('required Mcp-Name header is missing')
  }

  return { ok: true, identity: { method, name } }
}
