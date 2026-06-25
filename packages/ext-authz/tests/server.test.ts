import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { buildEvaluator } from '../src/policy.js'
import { createServer } from '../src/server.js'
import { createHoldStore as mkHolds } from '../src/hold.js'

let server: Server
let port: number
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-server-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n', 'utf-8')
  server = createServer({
    evaluator: buildEvaluator(policyPath),
    auditPath: join(dir, 'r.jsonl'),
    now: () => '2026-06-24T00:00:00.000Z',
    defaultServer: 'mcp',
    holds: mkHolds(join(dir, 'holds')),
    approvalBaseUrl: 'http://x/approve',
  })
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

describe('server error boundary', () => {
  it('returns 500 when the handler throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extauthz-err-'))
    const policyPath = join(dir, 'policy.yaml')
    writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "search"\n    action: allow\n', 'utf-8')
    const srv = createServer({
      evaluator: buildEvaluator(policyPath),
      auditPath: join(dir, 'r.jsonl'),
      now: () => { throw new Error('boom') },
      defaultServer: 'mcp',
      holds: mkHolds(join(dir, 'holds')),
      approvalBaseUrl: 'http://x/approve',
    })
    await new Promise<void>((r) => srv.listen(0, r))
    const p = (srv.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${p}/`, { method: 'POST', body: JSON.stringify({ method: 'tools/call', params: { name: 'search', arguments: {} } }) })
    expect(res.status).toBe(500)
    srv.close()
  })
})

describe('server approval flow', () => {
  it('holds then allows after out-of-band approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extauthz-srvapr-'))
    const policyPath = join(dir, 'policy.yaml')
    writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "payments.*"\n    action: require_approval\n', 'utf-8')
    const holds = mkHolds(join(dir, 'holds'))
    const srv = createServer({
      evaluator: buildEvaluator(policyPath),
      auditPath: join(dir, 'r.jsonl'),
      now: () => '2026-06-24T00:00:00.000Z',
      defaultServer: 'mcp',
      holds,
      approvalBaseUrl: 'http://x/approve',
    })
    await new Promise<void>((r) => srv.listen(0, r))
    const p = (srv.address() as AddressInfo).port
    const body = JSON.stringify({ method: 'tools/call', params: { name: 'payments.transfer', arguments: {} } })
    const first = await fetch(`http://127.0.0.1:${p}/`, { method: 'POST', body })
    expect(first.status).toBe(403)
    const runId = first.headers.get('x-jamjet-approval-id')!
    holds.resolve(runId, 'approved')
    const retry = await fetch(`http://127.0.0.1:${p}/`, { method: 'POST', body })
    expect(retry.status).toBe(200)
    srv.close()
  })
})
