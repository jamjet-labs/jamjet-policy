import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveServerCommand } from '../src/mcp/resolve.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jj-resolve-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveServerCommand', () => {
  it('uses explicit -- parts over any config', () => {
    const r = resolveServerCommand('x', ['node', 'srv.mjs', '--flag'])
    expect(r).toEqual({ command: 'node', args: ['srv.mjs', '--flag'], env: {} })
  })

  it('resolves from project config, and project beats user', () => {
    const proj = join(dir, 'proj.json')
    const user = join(dir, 'user.json')
    writeFileSync(proj, JSON.stringify({ mcpServers: { fs: { command: 'proj-cmd', args: ['p'] } } }))
    writeFileSync(user, JSON.stringify({ mcpServers: { fs: { command: 'user-cmd' } } }))
    const r = resolveServerCommand('fs', undefined, { projectConfig: proj, userConfig: user })
    expect(r.command).toBe('proj-cmd')
    expect(r.args).toEqual(['p'])
    expect(r.env).toEqual({})
  })

  it('falls back to user config and returns env, defaulting args to []', () => {
    const proj = join(dir, 'proj.json')
    const user = join(dir, 'user.json')
    writeFileSync(proj, JSON.stringify({ mcpServers: {} }))
    writeFileSync(user, JSON.stringify({ mcpServers: { fs: { command: 'u', env: { TOKEN: 't' } } } }))
    const r = resolveServerCommand('fs', undefined, { projectConfig: proj, userConfig: user })
    expect(r.command).toBe('u')
    expect(r.args).toEqual([])
    expect(r.env).toEqual({ TOKEN: 't' })
  })

  it('throws when not found and no -- given', () => {
    expect(() =>
      resolveServerCommand('missing', undefined, {
        projectConfig: join(dir, 'p.json'),
        userConfig: join(dir, 'u.json'),
      }),
    ).toThrow(/not found/)
  })

  it('throws a parse error naming the file', () => {
    const proj = join(dir, 'bad.json')
    writeFileSync(proj, '{ not json')
    expect(() =>
      resolveServerCommand('fs', undefined, { projectConfig: proj, userConfig: join(dir, 'u.json') }),
    ).toThrow(/bad\.json/)
  })
})
