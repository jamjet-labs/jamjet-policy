import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrustBaseline } from '@jamjet/mcp-threat'
import { trustApprove, trustReview } from '../src/mcp/trust.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-trust-cli-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('trustApprove', () => {
  it('pins the probed tools into the lock', async () => {
    const lockPath = join(dir, 'mcp-trust.lock')
    const probe = async () => [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }]
    await trustApprove({ name: 'demo', command: 'node', args: ['s.mjs'], env: {}, lockPath, probe })
    const b = loadTrustBaseline(lockPath)
    const demo = b.servers.demo!
    expect(demo).toBeDefined()
    expect(demo.fingerprint).toMatch(/^sha256:/)
    expect(Object.keys(demo.tools)).toEqual(['read_file'])
    expect(typeof demo.approved_at).toBe('string')
  })
})

describe('trustReview', () => {
  it('prints a hint when the lock is empty', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    trustReview({ lockPath: join(dir, 'none.lock') })
    expect(out.mock.calls.join('')).toMatch(/No servers approved yet/)
  })

  it('lists approved servers and their tools', async () => {
    const lockPath = join(dir, 'mcp-trust.lock')
    await trustApprove({
      name: 'demo', command: 'node', args: ['s.mjs'], env: {}, lockPath,
      probe: async () => [{ name: 'read_file' }, { name: 'list_dir' }],
    })
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    trustReview({ lockPath })
    const text = out.mock.calls.join('')
    expect(text).toMatch(/demo/)
    expect(text).toMatch(/read_file, list_dir/)
  })

  it('--json emits the lock as JSON', async () => {
    const lockPath = join(dir, 'mcp-trust.lock')
    await trustApprove({
      name: 'demo', command: 'node', args: [], env: {}, lockPath,
      probe: async () => [{ name: 'read_file' }],
    })
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    trustReview({ json: true, lockPath })
    const parsed = JSON.parse(out.mock.calls.join('')) as { servers: Record<string, { tools: Record<string, unknown> }> }
    expect(parsed.servers.demo!.tools.read_file).toBeDefined()
  })
})
