import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CloudClient, HaltedError, TransientError, PermanentError } from '../src/cloud/http.js'
import type { AuditEventV1 } from '../src/types.js'

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

function fakeEvent(run_id: string): AuditEventV1 {
  return {
    ts: '2026-05-13T00:00:00.000Z',
    run_id,
    adapter: 'openai-guardrail',
    host: 'openai-agents-sdk',
    tool: 'payments.refund',
    args: {},
    decision: 'BLOCKED',
    executed: false,
    schema_version: 1,
  } as AuditEventV1
}

describe('CloudClient', () => {
  let server: Server | undefined
  let port: number
  let client: CloudClient

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
  })

  it('postEvents returns parsed response on 200', async () => {
    ;({ server, port } = await startMockServer((req, res) => {
      // Verify request shape
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/v1/policy-audit/events')
      expect(req.headers.authorization).toBe('Bearer jj_test_key')
      expect(req.headers['content-type']).toBe('application/json')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: 2, rejected: 0, duplicates: 0, errors: [] }))
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const resp = await client.postEvents([fakeEvent('run_a'), fakeEvent('run_b')])
    expect(resp.accepted).toBe(2)
    expect(resp.rejected).toBe(0)
  })

  it('postEvents throws HaltedError on 401', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(401)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    await expect(client.postEvents([fakeEvent('run_a')])).rejects.toBeInstanceOf(HaltedError)
  })

  it('postEvents throws HaltedError on 403', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(403)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    await expect(client.postEvents([fakeEvent('run_a')])).rejects.toBeInstanceOf(HaltedError)
  })

  it('postEvents distinguishes 4xx (drop) from 5xx (retry)', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'bad' }))
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err = await client.postEvents([fakeEvent('run_a')]).catch((e) => e)
    expect(err).toBeInstanceOf(PermanentError)
    expect(err.kind).toBe('drop')
    expect(err.status).toBe(400)

    await new Promise<void>((r) => server!.close(() => r()))
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(503)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err2 = await client.postEvents([fakeEvent('run_a')]).catch((e) => e)
    expect(err2).toBeInstanceOf(TransientError)
    expect(err2.kind).toBe('retry')
  })

  it('postEvents treats 408 and 429 as transient (retry)', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(429)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err = await client.postEvents([fakeEvent('run_a')]).catch((e) => e)
    expect(err.kind).toBe('retry')

    await new Promise<void>((r) => server!.close(() => r()))
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(408)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err2 = await client.postEvents([fakeEvent('run_a')]).catch((e) => e)
    expect(err2.kind).toBe('retry')
  })

  it('postEvents wraps malformed-2xx as TransientError (not raw SyntaxError)', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('not json {')
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err = await client.postEvents([fakeEvent('run_a')]).catch((e) => e)
    expect(err).toBeInstanceOf(TransientError)
    expect(err.kind).toBe('retry')
  })

  it('approvalsPending wraps malformed-2xx as TransientError', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('garbage')
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err = await client.approvalsPending(['run_a']).catch((e) => e)
    expect(err).toBeInstanceOf(TransientError)
  })

  it('postEvents tags request body with pathMode for telemetry', async () => {
    let bodyCaptured = ''
    ;({ server, port } = await startMockServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        bodyCaptured = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: 1, rejected: 0, duplicates: 0, errors: [] }))
      })
    }))
    client = new CloudClient({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test_key',
      pathMode: 'direct',
    })
    await client.postEvents([fakeEvent('run_a')])
    const parsed = JSON.parse(bodyCaptured)
    expect(parsed.path).toBe('direct')
    expect(parsed.events).toHaveLength(1)
  })

  it('approvalsPending returns decided list', async () => {
    ;({ server, port } = await startMockServer((req, res) => {
      expect(req.method).toBe('GET')
      expect(req.url).toContain('/v1/policy-audit/approvals/pending')
      expect(req.url).toContain('run_ids=run_a%2Crun_b')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ run_id: 'run_a', status: 'APPROVED' }]))
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const decisions = await client.approvalsPending(['run_a', 'run_b'])
    expect(decisions).toEqual([{ run_id: 'run_a', status: 'APPROVED' }])
  })

  it('approvalsPending returns [] for empty run-id list without hitting the network', async () => {
    let called = false
    ;({ server, port } = await startMockServer((_req, res) => {
      called = true
      res.writeHead(500)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const decisions = await client.approvalsPending([])
    expect(decisions).toEqual([])
    expect(called).toBe(false)
  })

  it('approvalsPending throws HaltedError on 401', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(401)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    await expect(client.approvalsPending(['run_a'])).rejects.toBeInstanceOf(HaltedError)
  })

  it('approvalsPending treats 5xx as transient', async () => {
    ;({ server, port } = await startMockServer((_req, res) => {
      res.writeHead(503)
      res.end()
    }))
    client = new CloudClient({ apiBase: `http://127.0.0.1:${port}`, apiKey: 'jj_test_key' })
    const err = await client.approvalsPending(['run_a']).catch((e) => e)
    expect(err).toBeInstanceOf(TransientError)
  })

  it('sends a user-agent header (overridable)', async () => {
    let uaCaptured = ''
    ;({ server, port } = await startMockServer((req, res) => {
      uaCaptured = (req.headers['user-agent'] as string) ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: 0, rejected: 0, duplicates: 0, errors: [] }))
    }))
    client = new CloudClient({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: 'jj_test_key',
      userAgent: 'jamjet-cli/0.2.0 sync',
    })
    await client.postEvents([fakeEvent('run_a')])
    expect(uaCaptured).toBe('jamjet-cli/0.2.0 sync')
  })
})
