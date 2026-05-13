import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Daemon } from '../src/sync/daemon.js'
import type { Config } from '../src/types.js'

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

function startMockCloud(opts: {
  onEvents?: (body: unknown) => void
  approvalsResponse?: Array<{ run_id: string; status: string; decided_at?: string }>
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (req.url?.startsWith('/v1/policy-audit/events')) {
          let parsed: any = {}
          try {
            parsed = JSON.parse(body)
          } catch {
            // body might be empty
          }
          opts.onEvents?.(parsed)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              accepted: parsed.events?.length ?? 0,
              rejected: 0,
              duplicates: 0,
              errors: [],
            }),
          )
        } else if (req.url?.startsWith('/v1/policy-audit/approvals/pending')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(opts.approvalsResponse ?? []))
        } else {
          res.writeHead(404)
          res.end()
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, port })
    })
  })
}

function mkConfig(apiBase: string): Config {
  return {
    cloud: {
      project_id: randomUUID(),
      api_key: 'jj_testkey_' + 'a'.repeat(20),
      api_base: apiBase,
      args_redaction: 'full',
      push: 'interesting',
      poll_interval_seconds: 1,
      drainer_interval_seconds: 1,
      metrics_port: 9876,
      metrics_enabled: false,
      outbox_max_events: 100,
      outbox_max_age_days: 7,
    },
  }
}

function fakeEvent(run_id: string, decision = 'BLOCKED') {
  return JSON.stringify({
    ts: new Date().toISOString(),
    run_id,
    adapter: 'openai-guardrail',
    host: 'openai-agents-sdk',
    tool: 'payments.refund',
    decision,
    executed: false,
    schema_version: 1,
    args: { amount: 100 },
  })
}

describe('Daemon', () => {
  let home: string
  let server: Server | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jamjet-daemon-test-'))
    mkdirSync(join(home, 'audit', new Date().toISOString().slice(0, 10)), {
      recursive: true,
    })
    mkdirSync(join(home, 'pending'), { recursive: true })
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('starts, tails new events, pushes them, and stops cleanly', async () => {
    const pushed: any[] = []
    let port: number
    ;({ server, port } = await startMockCloud({
      onEvents: (body: any) => {
        if (body?.events) pushed.push(...body.events)
      },
    }))

    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon.start()

    const today = new Date().toISOString().slice(0, 10)
    appendFileSync(
      join(home, 'audit', today, 'a.jsonl'),
      fakeEvent('run_alpha') + '\n',
    )

    // tail + drainer interval (1s) + a bit
    await wait(2000)

    expect(pushed.length).toBeGreaterThanOrEqual(1)
    expect(pushed.some((e) => e.run_id === 'run_alpha')).toBe(true)

    const snap = daemon.snapshot()
    expect(snap.state).toBe('ok')
    expect(snap.events_pushed_total).toBeGreaterThanOrEqual(1)
    expect(snap.daemon_pid).toBe(process.pid)

    await daemon.stop()
  }, 10_000)

  it('redacts args before pushing (R9)', async () => {
    const pushed: any[] = []
    let port: number
    ;({ server, port } = await startMockCloud({
      onEvents: (body: any) => {
        if (body?.events) pushed.push(...body.events)
      },
    }))

    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon.start()

    const today = new Date().toISOString().slice(0, 10)
    appendFileSync(
      join(home, 'audit', today, 'a.jsonl'),
      fakeEvent('run_redact') + '\n',
    )
    await wait(2000)

    const found = pushed.find((e) => e.run_id === 'run_redact')
    expect(found).toBeDefined()
    expect(found.args).toEqual({ redacted: true })
    expect(found.args_redaction).toBe('full')

    await daemon.stop()
  }, 10_000)

  it('processes approval decisions from Cloud', async () => {
    let port: number
    ;({ server, port } = await startMockCloud({
      approvalsResponse: [
        {
          run_id: 'run_pending',
          status: 'APPROVED',
          decided_at: new Date().toISOString(),
        },
      ],
    }))

    // pre-create the pending file
    const pendingPath = join(home, 'pending', 'run_pending.json')
    appendFileSync(
      pendingPath,
      JSON.stringify({ run_id: 'run_pending', tool: 'x.y', status: 'pending' }),
    )

    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon.start()

    // poll interval is 1s
    await wait(2000)

    expect(existsSync(join(home, 'pending', 'resolved', 'run_pending.approved'))).toBe(true)
    expect(existsSync(pendingPath)).toBe(false)

    const marker = JSON.parse(
      readFileSync(join(home, 'pending', 'resolved', 'run_pending.approved'), 'utf-8'),
    )
    expect(marker.source).toBe('cloud')

    await daemon.stop()
  }, 10_000)

  it('rolls back lock + state when start() fails mid-init', async () => {
    let port: number
    ;({ server, port } = await startMockCloud({}))

    // Force start() to fail past acquireLock: pre-create outbox.db as a
    // directory so better-sqlite3 cannot open it.
    const syncDir = join(home, 'sync')
    mkdirSync(join(syncDir, 'outbox.db'), { recursive: true })

    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await expect(daemon.start()).rejects.toBeTruthy()
    expect(daemon.snapshot().state).toBe('not_running')
    expect(existsSync(join(syncDir, 'daemon.pid'))).toBe(false)

    // Fresh start after fixing the underlying issue.
    rmSync(join(syncDir, 'outbox.db'), { recursive: true, force: true })
    const daemon2 = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon2.start()
    expect(daemon2.snapshot().state).toBe('ok')
    await daemon2.stop()
  }, 10_000)

  it('snapshot reports not_running after stop()', async () => {
    let port: number
    ;({ server, port } = await startMockCloud({}))
    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon.start()
    expect(daemon.snapshot().state).toBe('ok')
    await daemon.stop()
    expect(daemon.snapshot().state).toBe('not_running')
  }, 10_000)

  it('replays backlog at startup', async () => {
    const pushed: any[] = []
    let port: number
    ;({ server, port } = await startMockCloud({
      onEvents: (body: any) => {
        if (body?.events) pushed.push(...body.events)
      },
    }))

    // pre-write a backlog event before starting the daemon
    const today = new Date().toISOString().slice(0, 10)
    appendFileSync(
      join(home, 'audit', today, 'backlog.jsonl'),
      fakeEvent('run_backlog') + '\n',
    )

    const daemon = new Daemon({
      config: mkConfig(`http://127.0.0.1:${port}`),
      homeDir: home,
    })
    await daemon.start()
    await wait(2000)

    expect(pushed.some((e) => e.run_id === 'run_backlog')).toBe(true)
    await daemon.stop()
  }, 10_000)
})
