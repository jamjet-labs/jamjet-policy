import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvaluator } from '../src/policy.js'
import { handleAuthz, type AuthzDeps } from '../src/handle.js'

function rpc(tool: string) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } })
}

let deps: AuthzDeps
let auditPath: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'extauthz-handle-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n', 'utf-8')
  auditPath = join(dir, 'receipts.jsonl')
  deps = { evaluator: buildEvaluator(policyPath), auditPath, now: () => '2026-06-24T00:00:00.000Z', defaultServer: 'mcp' }
})

describe('handleAuthz', () => {
  it('returns 200 and a receipt header for an allowed tool', () => {
    const res = handleAuthz(rpc('search'), {}, deps)
    expect(res.status).toBe(200)
    expect(res.headers['x-jamjet-receipt']).toMatch(/^sha256:/)
  })
  it('returns 403 for a blocked tool and writes a receipt', () => {
    const res = handleAuthz(rpc('delete_user'), {}, deps)
    expect(res.status).toBe(403)
    expect(existsSync(auditPath)).toBe(true)
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n')
    expect(lines.some((l) => l.includes('"decision":"BLOCKED"'))).toBe(true)
  })
  it('passes through non tools/call requests with 200', () => {
    const res = handleAuthz(JSON.stringify({ method: 'tools/list' }), {}, deps)
    expect(res.status).toBe(200)
  })
})
