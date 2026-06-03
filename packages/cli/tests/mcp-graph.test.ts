import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approveServer, saveTrustBaseline } from '@jamjet/mcp-threat'
import { mcpGraph } from '../src/mcp/graph.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-graph-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('mcpGraph', () => {
  it('prints the hint when the lock is empty', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mcpGraph({ format: 'text', risk: false, lockPath: join(dir, 'none.lock') })
    expect(out.mock.calls.join('')).toMatch(/No servers approved yet/)
  })

  it('renders servers with policy decisions from a lock + policy', () => {
    const lockPath = join(dir, 'mcp-trust.lock')
    const policyPath = join(dir, 'policy.yaml')
    saveTrustBaseline(lockPath, approveServer(
      { version: 1, servers: {} }, 'demo', 'id',
      [{ name: 'read_file' }, { name: 'delete_all' }], '2026-06-03T00:00:00.000Z',
    ))
    writeFileSync(policyPath, 'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mcpGraph({ format: 'text', risk: false, lockPath, policyPath })
    const text = out.mock.calls.join('')
    expect(text).toContain('demo')
    expect(text).toContain('read_file  allow')
    expect(text).toContain('delete_all  block')
  })

  it('emits JSON with format json (and tolerates a missing policy)', () => {
    const lockPath = join(dir, 'mcp-trust.lock')
    saveTrustBaseline(lockPath, approveServer(
      { version: 1, servers: {} }, 'demo', 'id', [{ name: 'read_file' }], '2026-06-03T00:00:00.000Z',
    ))
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mcpGraph({ format: 'json', risk: false, lockPath, policyPath: join(dir, 'missing.yaml') })
    const parsed = JSON.parse(out.mock.calls.join('')) as { servers: Array<{ name: string }> }
    expect(parsed.servers[0]!.name).toBe('demo')
  })
})
