import { spawn } from 'node:child_process'
import type { ToolDefinition } from '@jamjet/mcp-threat'

export interface ProbeOptions {
  command: string
  args: string[]
  env: Record<string, string>
  timeoutMs?: number
}

interface RpcMessage {
  id?: number | string
  result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }
  error?: { message?: string }
}

export function probeServerTools(opts: ProbeOptions): Promise<ToolDefinition[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  return new Promise<ToolDefinition[]>((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const stdin = child.stdin
    const stdout = child.stdout
    if (!stdin || !stdout) {
      child.kill('SIGTERM')
      reject(new Error('failed to open server stdio'))
      return
    }

    let settled = false
    let buffer = ''
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.end()
      child.kill('SIGTERM')
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`server did not complete tools/list within ${timeoutMs / 1000}s`)))
    }, timeoutMs)

    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException
      const msg = e.code === 'ENOENT' ? `could not launch server: '${opts.command}' not found` : e.message
      finish(() => reject(new Error(msg)))
    })

    const send = (obj: unknown): void => { stdin.write(JSON.stringify(obj) + '\n') }

    function handleLine(line: string): void {
      let msg: RpcMessage
      try { msg = JSON.parse(line) as RpcMessage } catch { return }
      if (msg.id === 1) {
        // initialize response -> announce initialized, then ask for tools
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        return
      }
      if (msg.id === 2) {
        if (msg.error) {
          finish(() => reject(new Error(`tools/list failed: ${msg.error?.message ?? 'unknown error'}`)))
          return
        }
        const tools = msg.result?.tools
        if (!Array.isArray(tools)) {
          finish(() => reject(new Error('server returned no tools')))
          return
        }
        const mapped: ToolDefinition[] = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
        finish(() => resolve(mapped))
      }
    }

    stdout.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) handleLine(line)
        nl = buffer.indexOf('\n')
      }
    })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jamjet', version: '0' } },
    })
  })
}
