import type { AuthzAction } from './types.js'

export interface ServerSource {
  /** Header the proxy sets to name the upstream. Absent: always use the default server. */
  header?: string
}

// Host-style names reach the PDP in many spellings for one upstream (PAYMENTS,
// payments:443, payments.). Fold them so a policy on "payments" sees all of them.
export function normalizeServer(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (s.endsWith('.')) s = s.slice(0, -1)
  const colon = s.lastIndexOf(':')
  if (colon > 0 && !s.includes(']') && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon)
  return s
}

export function parseAction(
  rawBody: string,
  headers: Record<string, string | undefined>,
  defaultServer: string,
  principalHeader?: string,
  serverSource?: ServerSource,
): AuthzAction | null {
  let rpc: unknown
  try {
    rpc = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (typeof rpc !== 'object' || rpc === null) return null
  const r = rpc as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
  if (r.method !== 'tools/call' || typeof r.params?.name !== 'string') return null
  // Without serverSource (no Cedar loaded) the server name is only a label in receipts
  // and hold keys, and the legacy header lookup stays. With Cedar it decides
  // `resource in JamJet::Server::"..."`, so a client-set header must not choose it: use
  // the configured default, or a header the operator says the proxy overwrites. A
  // configured header that is missing yields "", which Cedar blocks.
  let server: string
  if (!serverSource) server = headers['x-jamjet-server'] ?? headers['host'] ?? defaultServer
  else if (serverSource.header) server = normalizeServer(headers[serverSource.header.toLowerCase()] ?? '')
  else server = defaultServer
  const args = (r.params.arguments ?? {}) as Record<string, unknown>
  const principalId = principalHeader ? headers[principalHeader.toLowerCase()] : undefined
  return {
    server,
    tool: r.params.name,
    args,
    ...(typeof principalId === 'string' && principalId.length > 0 ? { principal: { id: principalId } } : {}),
  }
}
