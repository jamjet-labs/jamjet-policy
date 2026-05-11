import { describe, it, expect } from 'vitest'
import { JsonRpcStream } from '../src/jsonrpc.js'

describe('JsonRpcStream', () => {
  it('emits one message per newline-delimited JSON object', () => {
    const stream = new JsonRpcStream()
    const messages: unknown[] = []
    stream.on('message', (m) => messages.push(m))

    stream.feed(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'))
    stream.feed(Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'))
    expect(messages).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((messages[0] as any).method).toBe('initialize')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((messages[1] as any).id).toBe(2)
  })

  it('buffers partial lines until newline arrives', () => {
    const stream = new JsonRpcStream()
    const messages: unknown[] = []
    stream.on('message', (m) => messages.push(m))

    stream.feed(Buffer.from('{"jsonrpc":"2.0",'))
    expect(messages).toHaveLength(0)
    stream.feed(Buffer.from('"id":1,"method":"x"}\n'))
    expect(messages).toHaveLength(1)
  })

  it('skips empty lines', () => {
    const stream = new JsonRpcStream()
    const messages: unknown[] = []
    stream.on('message', (m) => messages.push(m))
    stream.feed(Buffer.from('\n\n{"jsonrpc":"2.0","id":1,"method":"x"}\n\n'))
    expect(messages).toHaveLength(1)
  })

  it('emits error event on malformed JSON line', () => {
    const stream = new JsonRpcStream()
    const errors: Error[] = []
    stream.on('error', (e) => errors.push(e))
    stream.feed(Buffer.from('{not json}\n'))
    expect(errors).toHaveLength(1)
  })

  it('static encode produces newline-terminated JSON', () => {
    const buf = JsonRpcStream.encode({ jsonrpc: '2.0', id: 1, method: 'x' })
    expect(buf.toString('utf-8')).toBe('{"jsonrpc":"2.0","id":1,"method":"x"}\n')
  })
})
