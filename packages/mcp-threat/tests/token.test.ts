import { describe, it, expect } from 'vitest'
import { parseJwtAudience, detectTokenPassthrough } from '../src/detectors/token.js'

// Build a JWT-shaped string with a given payload (signature irrelevant to audience parsing).
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`
}

describe('parseJwtAudience', () => {
  it('extracts a string aud', () => {
    expect(parseJwtAudience(jwt({ aud: 'other-server' }))).toBe('other-server')
  })
  it('returns null for a non-JWT string', () => {
    expect(parseJwtAudience('hello world')).toBeNull()
  })
  it('returns null for a JWT without aud', () => {
    expect(parseJwtAudience(jwt({ sub: 'x' }))).toBeNull()
  })
})

describe('detectTokenPassthrough', () => {
  it('flags a forwarded token whose audience is a different server', () => {
    const args = { auth: jwt({ aud: 'github-mcp' }) }
    const findings = detectTokenPassthrough('read_file', args, 'filesystem')
    expect(findings).toHaveLength(1)
    expect(findings[0].risk_class).toBe('token_passthrough')
    expect(findings[0].detail).toContain('github-mcp')
    expect(findings[0].detail).toContain('auth')
  })

  it('does not flag a token whose audience matches the target server', () => {
    const args = { auth: jwt({ aud: 'filesystem' }) }
    expect(detectTokenPassthrough('read_file', args, 'filesystem')).toEqual([])
  })

  it('ignores non-token string args', () => {
    expect(detectTokenPassthrough('read_file', { path: '/etc/hosts' }, 'filesystem')).toEqual([])
  })
})
