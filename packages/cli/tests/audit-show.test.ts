import { describe, it, expect } from 'vitest'
import { auditShow } from '../src/audit-show.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function captureStdout<T>(fn: () => T): { result: T; out: string } {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString())
    return true
  }) as typeof process.stdout.write
  try {
    const result = fn()
    return { result, out: chunks.join('') }
  } finally {
    process.stdout.write = orig
  }
}

describe('auditShow', () => {
  it('lists events for the given date sorted by ts across adapters', () => {
    const base = mkdtempSync(join(tmpdir(), 'jaudit-'))
    const day = '2026-05-11'
    mkdirSync(join(base, day), { recursive: true })

    writeFileSync(
      join(base, day, 'claude-code-hook.jsonl'),
      JSON.stringify({
        ts: `${day}T10:00:00Z`, run_id: 'run_a', adapter: 'claude-code-hook',
        host: 'claude-code', tool: 'db.delete', decision: 'BLOCKED',
        rule: '*delete*', executed: false, schema_version: 1,
      }) + '\n',
    )
    writeFileSync(
      join(base, day, 'mcp-shim.jsonl'),
      JSON.stringify({
        ts: `${day}T09:00:00Z`, run_id: 'run_b', adapter: 'mcp-shim',
        host: 'claude-desktop', tool: 'db.read', decision: 'ALLOWED',
        rule: null, executed: true, schema_version: 1,
      }) + '\n',
    )

    const { out } = captureStdout(() => auditShow({ baseDir: base, date: day }))
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/mcp-shim/) // earlier ts first
    expect(lines[1]).toMatch(/claude-code-hook/)
  })

  it('reports no events for an empty day', () => {
    const base = mkdtempSync(join(tmpdir(), 'jaudit-'))
    const { out } = captureStdout(() => auditShow({ baseDir: base, date: '2026-05-11' }))
    expect(out).toMatch(/no events/)
  })

  it('filters by adapter prefix when --adapter is set', () => {
    const base = mkdtempSync(join(tmpdir(), 'jaudit-'))
    const day = '2026-05-11'
    mkdirSync(join(base, day), { recursive: true })
    writeFileSync(
      join(base, day, 'claude-code-hook.jsonl'),
      JSON.stringify({
        ts: `${day}T10:00:00Z`, run_id: 'run_a', adapter: 'claude-code-hook',
        host: 'claude-code', tool: 'db.delete', decision: 'BLOCKED',
        rule: '*delete*', executed: false, schema_version: 1,
      }) + '\n',
    )
    writeFileSync(
      join(base, day, 'mcp-shim.jsonl'),
      JSON.stringify({
        ts: `${day}T09:00:00Z`, run_id: 'run_b', adapter: 'mcp-shim',
        host: 'claude-desktop', tool: 'db.read', decision: 'ALLOWED',
        rule: null, executed: true, schema_version: 1,
      }) + '\n',
    )

    const { out } = captureStdout(() =>
      auditShow({ baseDir: base, date: day, adapter: 'mcp-shim' }),
    )
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/mcp-shim/)
    expect(lines[0]).not.toMatch(/claude-code-hook/)
  })
})
