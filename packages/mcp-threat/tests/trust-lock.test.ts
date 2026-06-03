import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrustBaseline, saveTrustBaseline, approveServer } from '../src/trust-lock.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-trust-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('trust-lock', () => {
  it('returns an empty baseline when the file does not exist', () => {
    const b = loadTrustBaseline(join(dir, 'missing.lock'))
    expect(b).toEqual({ version: 1, servers: {} })
  })

  it('round-trips a saved baseline', () => {
    const path = join(dir, 'mcp-trust.lock')
    let b = loadTrustBaseline(path)
    b = approveServer(b, 'filesystem', 'sha256:server-id', [
      { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
    ], '2026-06-02T00:00:00.000Z')
    saveTrustBaseline(path, b)
    expect(existsSync(path)).toBe(true)
    const reloaded = loadTrustBaseline(path)
    expect(reloaded.servers.filesystem.fingerprint).toBe('sha256:server-id')
    expect(reloaded.servers.filesystem.approved_at).toBe('2026-06-02T00:00:00.000Z')
    expect(Object.keys(reloaded.servers.filesystem.tools)).toEqual(['read_file'])
    expect(reloaded.servers.filesystem.tools.read_file.desc_hash).toMatch(/^sha256:/)
  })

  it('approveServer replaces a prior approval for the same server', () => {
    let b: ReturnType<typeof loadTrustBaseline> = { version: 1, servers: {} }
    b = approveServer(b, 's', 'id1', [{ name: 'a' }], '2026-01-01T00:00:00.000Z')
    b = approveServer(b, 's', 'id2', [{ name: 'b' }], '2026-02-01T00:00:00.000Z')
    expect(b.servers.s.fingerprint).toBe('id2')
    expect(Object.keys(b.servers.s.tools)).toEqual(['b'])
  })
})
