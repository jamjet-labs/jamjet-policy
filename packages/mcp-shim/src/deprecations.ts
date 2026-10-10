/**
 * Features deprecated by MCP 2026-07-28 (SEP-2577): Roots, Sampling, Logging.
 * They stay functional for at least twelve months, so the shim does not break
 * them by default. What it does per feature is configurable (mcp.deprecated):
 *
 * - sampling (default warn): the server asks the client's model to generate
 *   text, possibly with tools. It is the one deprecated feature that lets a
 *   server drive the model, so every occurrence is reported on stderr.
 * - roots (default warn): exposes client filesystem roots to the server.
 *   Reported once per process.
 * - logging (default pass): informational server output; warning on each log
 *   line would only add noise.
 *
 * `block` refuses the message: a server request gets a JSON-RPC error back,
 * a client request gets a JSON-RPC error, a notification is dropped, and an
 * MRTR input_required result that asks for the feature is replaced with an error.
 */
import type { DeprecatedFeature } from './shim-config.js'

export type Direction = 'from_client' | 'from_server'

const FROM_SERVER: Record<string, DeprecatedFeature> = {
  'sampling/createMessage': 'sampling',
  'roots/list': 'roots',
  'notifications/message': 'logging',
}

const FROM_CLIENT: Record<string, DeprecatedFeature> = {
  'logging/setLevel': 'logging',
  'notifications/roots/list_changed': 'roots',
}

export function classifyDeprecated(direction: Direction, msg: unknown): DeprecatedFeature | null {
  const method = (msg as { method?: unknown } | null)?.method
  if (typeof method !== 'string') return null
  const table = direction === 'from_server' ? FROM_SERVER : FROM_CLIENT
  return Object.hasOwn(table, method) ? table[method]! : null
}

/** Deprecated features requested through a Multi Round-Trip `input_required` result. */
export function deprecatedInputRequests(result: unknown): Array<{ key: string; feature: DeprecatedFeature }> {
  const r = result as { resultType?: unknown; inputRequests?: unknown } | null
  if (!r || r.resultType !== 'input_required') return []
  const reqs = r.inputRequests
  if (!reqs || typeof reqs !== 'object' || Array.isArray(reqs)) return []
  const out: Array<{ key: string; feature: DeprecatedFeature }> = []
  for (const [key, req] of Object.entries(reqs as Record<string, unknown>)) {
    const method = (req as { method?: unknown } | null)?.method
    if (method === 'sampling/createMessage') out.push({ key, feature: 'sampling' })
    else if (method === 'roots/list') out.push({ key, feature: 'roots' })
  }
  return out
}
