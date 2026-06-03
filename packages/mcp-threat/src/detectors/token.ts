import type { ThreatFinding } from '../types.js'

// Multi-audience tokens (aud as a multi-element array) are intentionally not resolved to a single audience here; they return null (no single-target claim to compare). Tightening this is a follow-on.
/** Return the `aud` claim if `value` is a JWT carrying a string audience, else null. */
export function parseJwtAudience(value: string): string | null {
  const parts = value.split('.')
  if (parts.length !== 3) return null
  const payloadSegment = parts[1]
  if (payloadSegment === undefined) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf-8')) as Record<string, unknown>
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
  // Shallow scan: only top-level string args are inspected. Nested-object credential scanning is a follow-on.
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
