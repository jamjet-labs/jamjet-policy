import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url))

function sendAndRead(shim: ChildProcessWithoutNullStreams, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (b: Buffer) => {
      chunks.push(b)
      const acc = Buffer.concat(chunks).toString('utf-8')
      if (acc.includes('\n')) {
        shim.stdout.off('data', onData)
        resolve(acc.split('\n')[0]!)
      }
    }
    shim.stdout.on('data', onData)
    shim.stdin.write(payload + '\n')
  })
}

describe('mcp-shim integration', () => {
  it('blocks a tools/call matching policy', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-test-'))
    writeFileSync(join(dir, 'policy.yaml'),
      'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')

    const shim = spawn('node', [SHIM, '--policy', join(dir, 'policy.yaml'), '--server', 'pg', '--', 'node', FAKE], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    const response = await sendAndRead(shim, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'database.delete_all', arguments: {} },
    }))

    const parsed = JSON.parse(response)
    expect(parsed.error?.code).toBe(-32000)
    expect(parsed.error?.message).toMatch(/\*delete\*/)
    shim.kill()
  })

  it('forwards a tools/call that policy allows', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-test-'))
    writeFileSync(join(dir, 'policy.yaml'),
      'version: 1\nrules:\n  - { match: "*delete*", action: block }\n')

    const shim = spawn('node', [SHIM, '--policy', join(dir, 'policy.yaml'), '--server', 'pg', '--', 'node', FAKE], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    const response = await sendAndRead(shim, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'database.read_orders', arguments: {} },
    }))
    const parsed = JSON.parse(response)
    expect(parsed.result?.content?.[0]?.text).toMatch(/executed database.read_orders/)
    shim.kill()
  })
})
