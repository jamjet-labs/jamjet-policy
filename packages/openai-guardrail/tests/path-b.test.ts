/**
 * Tests for the Cloud Sync v0.1 Path B (direct-push) integration in the
 * guardrail. Mirrors sdk/python/tests/integrations/test_openai_guardrail_path_b.py.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CloudPusher } from '@jamjet/cloud'
import { jamjetGuardrail, JamjetPolicyBlocked } from '../src/guardrail.js'

function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, port })
    })
  })
}

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms))

function writePolicy(dir: string): string {
  const p = join(dir, 'policy.yaml')
  writeFileSync(p, 'version: 1\nrules:\n  - { match: "payments.refund", action: block }\n')
  return p
}

const BLOCK_INPUT = {
  toolName: 'payments.refund',
  toolArgs: { customer_email: 'alice@example.com', amount: 50_000 },
}

describe('jamjetGuardrail + Path B', () => {
  let dir: string
  let auditDir: string
  let server: Server | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jjog-pathb-'))
    auditDir = mkdtempSync(join(tmpdir(), 'jjog-pathb-audit-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
  })

  it('pushes to Cloud when cloudPusher is provided', async () => {
    const pushed: unknown[] = []
    let port: number
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        pushed.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        res.writeHead(200)
        res.end('{}')
      })
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
    })
    expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
    await wait()

    expect(pushed).toHaveLength(1)
    const body = pushed[0] as { path: string; events: Array<Record<string, unknown>> }
    expect(body.path).toBe('direct')
    expect(body.events[0].tool).toBe('payments.refund')
    expect(body.events[0].decision).toBe('BLOCKED')
  })

  it('redacts args before pushing (R9 default=full)', async () => {
    let bodyCaptured = ''
    let port: number
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        bodyCaptured = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200)
        res.end('{}')
      })
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
    })
    expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
    await wait()

    expect(bodyCaptured).not.toContain('alice@example.com')
    const parsed = JSON.parse(bodyCaptured)
    expect(parsed.events[0].args).toEqual({ redacted: true })
    expect(parsed.events[0].args_redaction).toBe('full')
  })

  it('local JSONL keeps full args even when push redacts them', async () => {
    let port: number
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end('{}')
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
    })
    expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
    await wait()

    // Find the JSONL file under the date directory.
    const dateDirs = readdirSync(auditDir)
    const dateDir = dateDirs.find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    expect(dateDir, `expected one date dir, got ${dateDirs.join(',')}`).toBeDefined()
    const jsonl = readFileSync(join(auditDir, dateDir!, 'openai-guardrail.jsonl'), 'utf-8')
    const event = JSON.parse(jsonl.trim()) as { args: Record<string, unknown> }
    expect(event.args.customer_email).toBe('alice@example.com')
  })

  it('hash redaction produces a stable sha256 fingerprint without leaking args', async () => {
    let bodyCaptured = ''
    let port: number
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        bodyCaptured = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200)
        res.end('{}')
      })
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
      argsRedaction: 'hash',
    })
    expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
    await wait()

    const parsed = JSON.parse(bodyCaptured)
    expect(parsed.events[0].args.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.events[0].args.redacted).toBe(true)
    expect(parsed.events[0].args_redaction).toBe('hash')
    expect(bodyCaptured).not.toContain('alice@example.com')
  })

  it('argsRedaction=none passes args verbatim (operator opt-in)', async () => {
    let bodyCaptured = ''
    let port: number
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        bodyCaptured = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200)
        res.end('{}')
      })
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
      argsRedaction: 'none',
    })
    expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
    await wait()

    const parsed = JSON.parse(bodyCaptured)
    expect(parsed.events[0].args.customer_email).toBe('alice@example.com')
    expect(parsed.events[0].args_redaction).toBe('none')
  })

  it('propagates trace_id from per-call headers', async () => {
    let bodyCaptured = ''
    let port: number
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        bodyCaptured = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200)
        res.end('{}')
      })
    }))
    const pusher = new CloudPusher({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test',
    })
    const guard = jamjetGuardrail({
      policy: writePolicy(dir),
      auditDestination: auditDir,
      cloudPusher: pusher,
    })
    const traceId = '0af7651916cd43dd8448eb211c80319c'
    expect(() =>
      guard({
        ...BLOCK_INPUT,
        headers: {
          traceparent: `00-${traceId}-b7ad6b7169203331-01`,
        },
      }),
    ).toThrow(JamjetPolicyBlocked)
    await wait()

    const parsed = JSON.parse(bodyCaptured)
    expect(parsed.events[0].trace_id).toBe(traceId)
  })

  it('no cloudPusher + no env → no HTTP attempt (local-only)', async () => {
    let port: number
    const callsBefore = vi.fn()
    ;({ server, port } = await startMockServer((req, _res) => {
      callsBefore()
    }))
    // Save and clear env so detectPathMode returns 'local-only'.
    const saved = {
      token: process.env.JAMJET_CLOUD_TOKEN,
      mode: process.env.JAMJET_CLOUD_MODE,
      vercel: process.env.VERCEL,
    }
    delete process.env.JAMJET_CLOUD_TOKEN
    delete process.env.JAMJET_CLOUD_MODE
    delete process.env.VERCEL
    try {
      const guard = jamjetGuardrail({
        policy: writePolicy(dir),
        auditDestination: auditDir,
      })
      expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
      await wait()
      expect(callsBefore).not.toHaveBeenCalled()
    } finally {
      if (saved.token) process.env.JAMJET_CLOUD_TOKEN = saved.token
      if (saved.mode) process.env.JAMJET_CLOUD_MODE = saved.mode
      if (saved.vercel) process.env.VERCEL = saved.vercel
      // Reference port so TypeScript doesn't flag it unused.
      void port
    }
  })

  it('explicit cloudPusher: null disables Path B even when env says direct', async () => {
    let port: number
    const sawCall = vi.fn()
    ;({ server, port } = await startMockServer((req, _res) => {
      sawCall()
    }))
    const savedToken = process.env.JAMJET_CLOUD_TOKEN
    const savedMode = process.env.JAMJET_CLOUD_MODE
    process.env.JAMJET_CLOUD_TOKEN = 'jj_test'
    process.env.JAMJET_CLOUD_MODE = 'direct'
    try {
      const guard = jamjetGuardrail({
        policy: writePolicy(dir),
        auditDestination: auditDir,
        cloudPusher: null,
      })
      expect(() => guard(BLOCK_INPUT)).toThrow(JamjetPolicyBlocked)
      await wait()
      expect(sawCall).not.toHaveBeenCalled()
      void port
    } finally {
      if (savedToken) process.env.JAMJET_CLOUD_TOKEN = savedToken
      else delete process.env.JAMJET_CLOUD_TOKEN
      if (savedMode) process.env.JAMJET_CLOUD_MODE = savedMode
      else delete process.env.JAMJET_CLOUD_MODE
    }
  })
})
