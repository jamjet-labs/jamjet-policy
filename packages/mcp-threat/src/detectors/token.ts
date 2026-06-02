import type { ThreatFinding } from '../types.js'

/** Return the `aud` claim if `value` is a JWT carrying a string audience, else null. */
export function parseJwtAudience(value: string): string | null {
  const parts = value.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>
    const aud = payload.aud
    if (typeof aud === 'string') return aud
    if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === 'string') return aud[0]
    return null
  } catch {
    return null
  }
}

export function detectTokenPassthrough(
  tool: string,
  args: Record<string, unknown>,
  targetServer: string,
): ThreatFinding[] {
  const findings: ThreatFinding[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    const aud = parseJwtAudience(value)
    if (aud !== null && aud !== targetServer) {
      findings.push({
        risk_class: 'token_passthrough',
        server: targetServer,
        tool,
        detail: `arg '${key}' forwards a token whose audience '${aud}' is not the target server '${targetServer}'`,
      })
    }
  }
  return findings
}
