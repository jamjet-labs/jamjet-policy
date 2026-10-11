import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runPinsCommand } from '../src/pins-cli.js'
import { loadPinFile } from '../src/tool-pins.js'

const H = 'sha256:' + 'c'.repeat(64)
const pinsPath = () => join(mkdtempSync(join(tmpdir(), 'pins-cli-')), 'pins.json')

describe('pins approve', () => {
  it('writes an approved pin', () => {
    const p = pinsPath()
    const r = runPinsCommand(['approve', '--server', 'fs', '--tool', 'read_file', '--hash', H, '--pins', p], () => '2026-10-11T00:00:00.000Z')
    expect(r.code).toBe(0)
    expect(loadPinFile(p).servers.fs!.read_file).toEqual({ hash: H, pinned_at: '2026-10-11T00:00:00.000Z', source: 'approved' })
  })

  it('refuses a malformed hash', () => {
    const r = runPinsCommand(['approve', '--server', 'fs', '--tool', 't', '--hash', 'abc', '--pins', pinsPath()])
    expect(r.code).toBe(64)
  })

  it('refuses missing arguments', () => {
    expect(runPinsCommand(['approve', '--server', 'fs', '--hash', H, '--pins', pinsPath()]).code).toBe(64)
    expect(runPinsCommand(['approve', '--tool', 't', '--hash', H, '--pins', pinsPath()]).code).toBe(64)
  })

  it('does not overwrite a malformed pin file', () => {
    const p = pinsPath()
    writeFileSync(p, '{broken')
    const r = runPinsCommand(['approve', '--server', 'fs', '--tool', 't', '--hash', H, '--pins', p])
    expect(r.code).toBe(1)
  })

  it('lists pins', () => {
    const p = pinsPath()
    runPinsCommand(['approve', '--server', 'fs', '--tool', 'read_file', '--hash', H, '--pins', p])
    const r = runPinsCommand(['list', '--pins', p])
    expect(r.code).toBe(0)
    expect(r.out).toContain('fs')
    expect(r.out).toContain('read_file')
    expect(r.out).toContain(H)
  })

  it('rejects an unknown subcommand', () => {
    expect(runPinsCommand(['revoke']).code).toBe(64)
  })
})
