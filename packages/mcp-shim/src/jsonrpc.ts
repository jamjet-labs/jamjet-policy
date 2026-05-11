import { EventEmitter } from 'node:events'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

interface JsonRpcStreamEvents {
  message: (m: JsonRpcMessage) => void
  error: (e: Error) => void
}

export class JsonRpcStream extends EventEmitter {
  private buffer = ''

  override on<E extends keyof JsonRpcStreamEvents>(event: E, listener: JsonRpcStreamEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override emit<E extends keyof JsonRpcStreamEvents>(
    event: E,
    ...args: Parameters<JsonRpcStreamEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }

  feed(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    let newlineIdx = this.buffer.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (line.length > 0) {
        try {
          this.emit('message', JSON.parse(line) as JsonRpcMessage)
        } catch (err) {
          this.emit('error', err as Error)
        }
      }
      newlineIdx = this.buffer.indexOf('\n')
    }
  }

  static encode(m: JsonRpcMessage): Buffer {
    return Buffer.from(JSON.stringify(m) + '\n', 'utf-8')
  }
}
