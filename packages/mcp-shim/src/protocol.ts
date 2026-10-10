/**
 * Protocol version handling for the stdio shim.
 *
 * The shim governs messages by parsing them, so it can only vouch for protocol
 * versions whose message shapes it knows. Two eras exist (spec 2026-07-28,
 * "Versioning and Compatibility"):
 *
 * - legacy: version negotiated once by `initialize` (2025-11-25 and earlier)
 * - modern: version carried on every request in
 *   `params._meta["io.modelcontextprotocol/protocolVersion"]` (2026-07-28)
 *
 * An unknown version is never forwarded silently: it is refused with
 * UnsupportedProtocolVersionError (-32022), or, when the operator opts in with
 * `mcp.protocol.unknown_versions: pass`, forwarded with a stderr warning.
 */

export const MODERN_VERSIONS = ['2026-07-28'] as const
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const KNOWN_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

export const UNSUPPORTED_PROTOCOL_VERSION = -32022
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'

export type Era = 'legacy' | 'modern'

export type VersionClass =
  | { kind: 'none' }
  | { kind: 'known'; version: string; era: Era }
  | { kind: 'unknown'; version: unknown }

const modernSet: ReadonlySet<string> = new Set(MODERN_VERSIONS)
const legacySet: ReadonlySet<string> = new Set(LEGACY_VERSIONS)
const knownSet: ReadonlySet<string> = new Set(KNOWN_VERSIONS)

function paramsOf(msg: unknown): Record<string, unknown> | undefined {
  const p = (msg as { params?: unknown } | null)?.params
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined
}

/** Classify the protocol version a client request declares, if any. */
export function classifyClientRequestVersion(msg: unknown): VersionClass {
  const params = paramsOf(msg)
  const method = (msg as { method?: unknown } | null)?.method

  if (method === 'initialize') {
    const v = params?.protocolVersion
    if (typeof v === 'string' && legacySet.has(v)) return { kind: 'known', version: v, era: 'legacy' }
    return { kind: 'unknown', version: v }
  }

  const meta = params?._meta
  if (meta && typeof meta === 'object' && META_PROTOCOL_VERSION in (meta as object)) {
    const v = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION]
    if (typeof v === 'string' && modernSet.has(v)) return { kind: 'known', version: v, era: 'modern' }
    return { kind: 'unknown', version: v }
  }
  return { kind: 'none' }
}

export function unsupportedVersionError<I extends number | string | null>(id: I, requested: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: {
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version (JamJet shim cannot govern this version)',
      data: { supported: [...KNOWN_VERSIONS], requested },
    },
  }
}

/** Check the version a legacy server picked in its `initialize` result. */
export function checkInitializeResult(result: unknown): { ok: true } | { ok: false; version: unknown } {
  const v = (result as { protocolVersion?: unknown } | null)?.protocolVersion
  if (typeof v === 'string' && legacySet.has(v)) return { ok: true }
  return { ok: false, version: v }
}

/**
 * Narrow a `server/discover` result to versions the shim understands, so a
 * client never selects a version the shim would then refuse.
 */
export function filterDiscoverResult<T extends { supportedVersions?: unknown }>(
  result: T,
): { result: T & { supportedVersions: string[] }; removed: unknown[] } {
  const list = Array.isArray(result.supportedVersions) ? result.supportedVersions : []
  const kept: string[] = []
  const removed: unknown[] = []
  for (const v of list) {
    if (typeof v === 'string' && knownSet.has(v)) kept.push(v)
    else removed.push(v)
  }
  return { result: { ...result, supportedVersions: kept }, removed }
}
