import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAuditInChild } from '../src/audit.js'

let dir: string
const req = { dir: '/unused', rotateDaily: true, ts: '2026-01-01T00:00:00.000Z', line: '{}\n' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-child-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writer(body: string): string {
  const p = join(dir, 'writer.mjs')
  writeFileSync(p, body)
  return p
}

describe('writeAuditInChild', () => {
  it('rejects and kills the child when it does not finish in time', async () => {
    const hang = writer('process.stdin.resume(); setInterval(() => {}, 1000)\n')
    const started = Date.now()
    await expect(writeAuditInChild(hang, req, 300)).rejects.toThrow('audit write did not finish within 300 ms')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('rejects with the writer error when it exits non-zero', async () => {
    const fail = writer('process.stdin.resume(); process.stderr.write("disk on fire\\n"); process.exit(1)\n')
    await expect(writeAuditInChild(fail, req, 5000)).rejects.toThrow('disk on fire')
  })

  it('resolves when the writer exits 0', async () => {
    const ok = writer('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))\n')
    await expect(writeAuditInChild(ok, req, 5000)).resolves.toBeUndefined()
  })

  it('rejects when the writer cannot be started', async () => {
    await expect(writeAuditInChild(join(dir, 'missing.mjs'), req, 5000)).rejects.toThrow()
  })
})
