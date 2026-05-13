import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { cloudLink } from '../src/cloud/link.js'

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        handler(req, res, body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, port })
    })
  })
}

describe('cloudLink', () => {
  let dir: string
  let server: Server | undefined
  let outputs: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jamjet-link-test-'))
    outputs = []
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('completes the device-auth flow on success', async () => {
    let port: number
    let tokenCalls = 0
    ;({ server, port } = await startServer((req, res, body) => {
      if (req.url === '/v1/cli/device-code') {
        const parsed = JSON.parse(body)
        expect(parsed.client).toBe('jamjet-cli')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dev_xyz',
            user_code: 'ABCD-1234',
            verification_uri: 'http://localhost/cli/verify',
            expires_in: 600,
            interval: 1,
          }),
        )
      } else if (req.url === '/v1/cli/token') {
        tokenCalls++
        const parsed = JSON.parse(body)
        expect(parsed.device_code).toBe('dev_xyz')
        if (tokenCalls === 1) {
          res.writeHead(401)
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              api_key: 'jj_abcdefghijklmnop1234567890abcdef',
              project_id: '11111111-1111-1111-1111-111111111111',
              project_name: 'demo-project',
            }),
          )
        }
      } else {
        res.writeHead(404)
        res.end()
      }
    }))

    const cfgPath = join(dir, 'config.yaml')
    const data = await cloudLink({
      apiBase: `http://127.0.0.1:${port}`,
      pollIntervalMs: 10,
      configFile: cfgPath,
      stdout: (s) => outputs.push(s),
    })
    expect(data.api_key).toMatch(/^jj_/)
    expect(data.project_name).toBe('demo-project')
    expect(tokenCalls).toBe(2)

    const cfg = parseYaml(readFileSync(cfgPath, 'utf-8'))
    expect(cfg.cloud.api_key).toBe(data.api_key)
    expect(cfg.cloud.project_id).toBe(data.project_id)
    expect(cfg.cloud.api_base).toBe(`http://127.0.0.1:${port}`)

    // 0600 perms (Unix only)
    if (process.platform !== 'win32') {
      const mode = statSync(cfgPath).mode & 0o777
      expect(mode).toBe(0o600)
    }

    // Verification URI + user_code printed to stdout
    const out = outputs.join('')
    expect(out).toContain('http://localhost/cli/verify')
    expect(out).toContain('ABCD-1234')
    expect(out).toContain('demo-project')
  })

  it('throws on device-code request failure', async () => {
    let port: number
    ;({ server, port } = await startServer((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    }))
    await expect(
      cloudLink({
        apiBase: `http://127.0.0.1:${port}`,
        pollIntervalMs: 10,
        configFile: join(dir, 'config.yaml'),
        stdout: () => {},
      }),
    ).rejects.toThrow(/device-code request failed/)
  })

  it('throws on 403 (user denied)', async () => {
    let port: number
    ;({ server, port } = await startServer((req, res) => {
      if (req.url === '/v1/cli/device-code') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dev_xyz',
            user_code: 'XYZ',
            verification_uri: 'http://x',
            expires_in: 600,
            interval: 1,
          }),
        )
      } else {
        res.writeHead(403)
        res.end()
      }
    }))
    await expect(
      cloudLink({
        apiBase: `http://127.0.0.1:${port}`,
        pollIntervalMs: 10,
        configFile: join(dir, 'config.yaml'),
        stdout: () => {},
      }),
    ).rejects.toThrow(/authorization denied/)
  })

  it('throws on 400 (device_code expired/unknown)', async () => {
    let port: number
    ;({ server, port } = await startServer((req, res) => {
      if (req.url === '/v1/cli/device-code') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dev_xyz',
            user_code: 'XYZ',
            verification_uri: 'http://x',
            expires_in: 600,
            interval: 1,
          }),
        )
      } else {
        res.writeHead(400)
        res.end('expired')
      }
    }))
    await expect(
      cloudLink({
        apiBase: `http://127.0.0.1:${port}`,
        pollIntervalMs: 10,
        configFile: join(dir, 'config.yaml'),
        stdout: () => {},
      }),
    ).rejects.toThrow(/device_code rejected/)
  })

  it('times out cleanly', async () => {
    let port: number
    ;({ server, port } = await startServer((req, res) => {
      if (req.url === '/v1/cli/device-code') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dev_xyz',
            user_code: 'XYZ',
            verification_uri: 'http://x',
            expires_in: 600,
            interval: 1,
          }),
        )
      } else {
        res.writeHead(401)
        res.end()
      }
    }))
    await expect(
      cloudLink({
        apiBase: `http://127.0.0.1:${port}`,
        pollIntervalMs: 10,
        timeoutMs: 50,
        configFile: join(dir, 'config.yaml'),
        stdout: () => {},
      }),
    ).rejects.toThrow(/timed out/)
  })

  it('merges into an existing config.yaml without dropping other keys', async () => {
    const cfgPath = join(dir, 'config.yaml')
    writeFileSync(
      cfgPath,
      'cloud:\n  args_redaction: hash\n  push: all\nother: keep-me\n',
    )

    let port: number
    let tokenCalls = 0
    ;({ server, port } = await startServer((req, res) => {
      if (req.url === '/v1/cli/device-code') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            device_code: 'dev_xyz',
            user_code: 'X',
            verification_uri: 'http://x',
            expires_in: 600,
            interval: 1,
          }),
        )
      } else {
        tokenCalls++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            api_key: 'jj_' + 'a'.repeat(32),
            project_id: '11111111-1111-1111-1111-111111111111',
            project_name: 'demo',
          }),
        )
      }
    }))

    await cloudLink({
      apiBase: `http://127.0.0.1:${port}`,
      pollIntervalMs: 10,
      configFile: cfgPath,
      stdout: () => {},
    })

    const cfg = parseYaml(readFileSync(cfgPath, 'utf-8'))
    expect(cfg.cloud.args_redaction).toBe('hash') // preserved
    expect(cfg.cloud.push).toBe('all') // preserved
    expect(cfg.cloud.api_key).toMatch(/^jj_/) // new
    expect(cfg.other).toBe('keep-me') // unrelated top-level key preserved
  })
})
