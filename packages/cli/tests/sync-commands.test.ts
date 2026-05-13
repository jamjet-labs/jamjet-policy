import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncStatus } from '../src/sync/status.js'
import { syncVerify } from '../src/sync/verify.js'
import { syncInstall } from '../src/sync/install.js'
import { Outbox } from '../src/sync/outbox.js'

describe('syncStatus', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jamjet-status-test-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('reports not_running when no PID file exists', async () => {
    const out: string[] = []
    const s = await syncStatus({ homeDir: home, stdout: (x) => out.push(x) })
    expect(s.state).toBe('not_running')
    expect(s.daemon_pid).toBeUndefined()
    expect(s.outbox_depth).toBe(0)
    expect(out.join('')).toContain('not_running')
  })

  it('reports daemon pid + started_at when lock file exists', async () => {
    mkdirSync(join(home, 'sync'), { recursive: true })
    writeFileSync(
      join(home, 'sync', 'daemon.pid'),
      JSON.stringify({ pid: 9999, started_at: '2026-05-13T00:00:00Z' }),
    )
    const s = await syncStatus({ homeDir: home, stdout: () => {} })
    expect(s.state).toBe('ok')
    expect(s.daemon_pid).toBe(9999)
    expect(s.daemon_started_at).toBe('2026-05-13T00:00:00Z')
  })

  it('reads outbox depth + oldest_ts when DB exists', async () => {
    mkdirSync(join(home, 'sync'), { recursive: true })
    const outbox = new Outbox(join(home, 'sync', 'outbox.db'))
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"b":2}', '2026-05-12T01:00:00Z')
    outbox.close()
    const s = await syncStatus({ homeDir: home, stdout: () => {} })
    expect(s.outbox_depth).toBe(2)
    expect(s.outbox_oldest_ts).toBe('2026-05-12T00:00:00Z')
  })

  it('layers snapshot.json counters when present', async () => {
    mkdirSync(join(home, 'sync'), { recursive: true })
    writeFileSync(
      join(home, 'sync', 'status.json'),
      JSON.stringify({
        state: 'degraded',
        events_pushed_total: 1234,
        http_5xx_total: 7,
        last_successful_push_at: '2026-05-13T00:01:00Z',
      }),
    )
    const s = await syncStatus({ homeDir: home, stdout: () => {} })
    expect(s.state).toBe('degraded')
    expect(s.events_pushed_total).toBe(1234)
    expect(s.http_5xx_total).toBe(7)
    expect(s.last_successful_push_at).toBe('2026-05-13T00:01:00Z')
  })

  it('emits JSON when json=true', async () => {
    mkdirSync(join(home, 'sync'), { recursive: true })
    const out: string[] = []
    await syncStatus({ homeDir: home, json: true, stdout: (x) => out.push(x) })
    const parsed = JSON.parse(out.join(''))
    expect(parsed.state).toBe('not_running')
    expect(parsed.outbox_depth).toBe(0)
  })

  it('survives corrupt status.json', async () => {
    mkdirSync(join(home, 'sync'), { recursive: true })
    writeFileSync(join(home, 'sync', 'status.json'), 'not json {')
    const s = await syncStatus({ homeDir: home, stdout: () => {} })
    expect(s.state).toBe('not_running')
  })
})

describe('syncVerify', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jamjet-verify-test-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const EVT = (run_id: string, decision: string = 'BLOCKED', tsOffsetMin = 60) => {
    const ts = new Date(Date.now() - tsOffsetMin * 60 * 1000).toISOString()
    return JSON.stringify({
      ts,
      run_id,
      adapter: 'openai-guardrail',
      host: 'openai-agents-sdk',
      tool: 'x.y',
      decision,
      executed: false,
      schema_version: 1,
      args: {},
    })
  }

  it('counts local interesting events for the date', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const auditDir = join(home, 'audit', today)
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      EVT('run_a', 'BLOCKED') + '\n' +
        EVT('run_b', 'AUDIT') + '\n' +
        EVT('run_c', 'ALLOWED') + '\n',
    )
    const r = await syncVerify({ date: today, homeDir: home, skewMinutes: 0 })
    expect(r.local).toBe(2) // ALLOWED dropped
    expect(r.cloud_query_supported).toBe(false)
  })

  it('counts parse errors separately', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const auditDir = join(home, 'audit', today)
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      '{not json\n' + EVT('run_a', 'BLOCKED') + '\n',
    )
    const r = await syncVerify({ date: today, homeDir: home, skewMinutes: 0 })
    expect(r.local).toBe(1)
    expect(r.local_parse_errors).toBe(1)
  })

  it('skips events within the skew window', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const auditDir = join(home, 'audit', today)
    mkdirSync(auditDir, { recursive: true })
    // ts = "now" minus 1 min, with skew = 5 min → should be excluded
    writeFileSync(join(auditDir, 'a.jsonl'), EVT('run_recent', 'BLOCKED', 1) + '\n')
    const r = await syncVerify({ date: today, homeDir: home, skewMinutes: 5 })
    expect(r.local).toBe(0)
  })

  it('returns 0 when date directory missing', async () => {
    const r = await syncVerify({ date: '2020-01-01', homeDir: home, skewMinutes: 0 })
    expect(r.local).toBe(0)
    expect(r.local_parse_errors).toBe(0)
  })
})

describe('syncInstall', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jamjet-install-test-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('renders a launchd plist on darwin (dry-run)', async () => {
    const r = await syncInstall({
      dryRun: true,
      homeDir: home,
      forcePlatform: 'darwin',
      nodeBin: '/usr/local/bin/node',
      cliEntry: '/some/path/jamjet',
      stdout: () => {},
    })
    expect(r.path).toContain('Library/LaunchAgents/dev.jamjet.sync.plist')
    expect(r.content).toContain('<key>Label</key><string>dev.jamjet.sync</string>')
    expect(r.content).toContain('/usr/local/bin/node')
    expect(r.content).toContain('/some/path/jamjet')
    expect(r.enableCommand).toContain('launchctl load')
  })

  it('renders a systemd unit on linux (dry-run)', async () => {
    const r = await syncInstall({
      dryRun: true,
      homeDir: home,
      forcePlatform: 'linux',
      nodeBin: '/usr/bin/node',
      cliEntry: '/usr/local/lib/jamjet/dist/index.js',
      stdout: () => {},
    })
    expect(r.path).toContain('.config/systemd/user/jamjet-sync.service')
    expect(r.content).toContain('Description=JamJet Cloud Sync daemon')
    expect(r.content).toContain('ExecStart=/usr/bin/node /usr/local/lib/jamjet/dist/index.js sync start')
    expect(r.content).toContain('Restart=always')
    expect(r.enableCommand).toContain('systemctl --user enable --now')
  })

  it('throws on win32', async () => {
    await expect(
      syncInstall({
        homeDir: home,
        forcePlatform: 'win32',
        stdout: () => {},
      }),
    ).rejects.toThrow(/not supported/)
  })

  it('actually writes the file when dryRun=false', async () => {
    const out: string[] = []
    const r = await syncInstall({
      homeDir: home,
      forcePlatform: 'linux',
      nodeBin: '/usr/bin/node',
      cliEntry: '/x/y',
      stdout: (s) => out.push(s),
    })
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path, 'utf-8')).toBe(r.content)
    expect(out.join('')).toContain(r.path)
  })
})
