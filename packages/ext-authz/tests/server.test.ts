import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { buildEvaluator } from '../src/policy.js'
import { createServer } from '../src/server.js'

let server: Server
let port: number
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-server-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n', 'utf-8')
  server = createServer({ evaluator: buildEvaluator(policyPath), auditPath: join(dir, 'r.jsonl'), now: () => '2026-06-24T00:00:00.000Z', defaultServer: 'mcp' })
  await new Promise<void>((r) => server.listen(0, r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())

function call(tool: string) {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
  })
}

describe('createServer', () => {
  it('allows search (200)', async () => {
    const res = await call('search')
    expect(res.status).toBe(200)
  })
  it('blocks delete_user (403)', async () => {
    const res = await call('delete_user')
    expect(res.status).toBe(403)
  })
})
