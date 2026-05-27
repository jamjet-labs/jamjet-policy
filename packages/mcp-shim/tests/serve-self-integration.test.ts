import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

function writePolicy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shim-serve-self-'))
  const path = join(dir, 'policy.yaml')
  writeFileSync(
    path,
    'version: 1\nrules:\n  - { match: "*delete*", action: block }\n  - { match: "payments.*", action: require_approval }\n',
  )
  return path
}

interface MCPResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

function nextResponse(
  proc: ChildProcessWithoutNullStreams,
  predicate: (r: MCPResponse) => boolean,
): Promise<MCPResponse> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (b: Buffer) => {
      buf += b.toString('utf-8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as MCPResponse
          if (predicate(parsed)) {
            proc.stdout.off('data', onData)
            resolve(parsed)
            return
          }
        } catch (err) {
          proc.stdout.off('data', onData)
          reject(err)
          return
        }
      }
    }
    proc.stdout.on('data', onData)
  })
}

describe('--serve-self integration', () => {
  it('responds to initialize + tools/list + tools/call over stdio', { timeout: 20_000 }, async () => {
    const policyPath = writePolicy()
    const proc = spawn('node', [SHIM, '--serve-self', '--policy', policyPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    try {
      // 1. initialize
      const initPromise = nextResponse(proc, (r) => r.id === 1)
      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
      )
      const init = await initPromise
      const initResult = init.result as { serverInfo: { name: string }; capabilities: { tools: object } }
      expect(initResult.serverInfo.name).toBe('jamjet-policy')
      expect(initResult.capabilities.tools).toBeDefined()

      // 2. tools/list
      const listPromise = nextResponse(proc, (r) => r.id === 2)
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
      const list = await listPromise
      const listResult = list.result as { tools: Array<{ name: string }> }
      expect(listResult.tools.map((t) => t.name).sort()).toEqual(
        ['policy_evaluate', 'policy_list_rules', 'policy_load_info'],
      )

      // 3. tools/call policy_evaluate on a blocking pattern
      const evalPromise = nextResponse(proc, (r) => r.id === 3)
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'policy_evaluate', arguments: { tool_name: 'fs.delete_file' } },
        }) + '\n',
      )
      const evalResp = await evalPromise
      const evalResult = evalResp.result as { structuredContent: { decision: string; matched_pattern: string } }
      expect(evalResult.structuredContent.decision).toBe('block')
      expect(evalResult.structuredContent.matched_pattern).toBe('*delete*')
    } finally {
      proc.kill('SIGTERM')
    }
  })

  it(
    'falls back to built-in demo policy when no --policy is supplied and none is discoverable',
    { timeout: 20_000 },
    async () => {
      // Empty cwd + redirected HOME so loadPolicy()'s search chain (env → cwd → ~/.jamjet) misses.
      const emptyDir = mkdtempSync(join(tmpdir(), 'shim-no-policy-'))
      const fakeHome = mkdtempSync(join(tmpdir(), 'shim-fake-home-'))
      const proc = spawn('node', [SHIM, '--serve-self'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: emptyDir,
        env: {
          ...process.env,
          HOME: fakeHome,
          JAMJET_POLICY_FILE: '',
        },
      }) as ChildProcessWithoutNullStreams

      const stderrChunks: Buffer[] = []
      proc.stderr.on('data', (b: Buffer) => stderrChunks.push(b))

      try {
        const initPromise = nextResponse(proc, (r) => r.id === 100)
        proc.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'initialize', params: {} }) + '\n',
        )
        await initPromise

        const infoPromise = nextResponse(proc, (r) => r.id === 101)
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0', id: 101, method: 'tools/call',
            params: { name: 'policy_load_info' },
          }) + '\n',
        )
        const info = await infoPromise
        const infoResult = info.result as {
          content: Array<{ text: string }>
          structuredContent: { policy_source: string; rules_count: number }
        }
        expect(infoResult.structuredContent.policy_source).toBe('demo')
        expect(infoResult.structuredContent.rules_count).toBeGreaterThan(0)
        expect(infoResult.content[0].text).toMatch(/demo/i)

        const stderr = Buffer.concat(stderrChunks).toString('utf-8')
        expect(stderr).toMatch(/built-in demo policy/i)
        expect(stderr).toMatch(/--policy/)

        // Sanity: the demo policy actually evaluates — *delete* should block.
        const evalPromise = nextResponse(proc, (r) => r.id === 102)
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0', id: 102, method: 'tools/call',
            params: { name: 'policy_evaluate', arguments: { tool_name: 'fs.delete_file' } },
          }) + '\n',
        )
        const evalResp = await evalPromise
        const evalResult = evalResp.result as { structuredContent: { decision: string } }
        expect(evalResult.structuredContent.decision).toBe('block')
      } finally {
        proc.kill('SIGTERM')
      }
    },
  )
})
