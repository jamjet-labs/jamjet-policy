import type { AuthzAction } from './types.js'

export function parseAction(
  rawBody: string,
  headers: Record<string, string | undefined>,
  defaultServer: string,
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
  const server = headers['x-jamjet-server'] ?? headers['host'] ?? defaultServer
  const args = (r.params.arguments ?? {}) as Record<string, unknown>
  return { server, tool: r.params.name, args }
}
