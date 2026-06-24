import { describe, it, expect } from 'vitest'
import { parseAction } from '../src/parse.js'

const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_user', arguments: { id: 7 } } })

describe('parseAction', () => {
  it('extracts tool + args from a tools/call body', () => {
    const a = parseAction(rpc, { host: 'svc' }, 'mcp')
    expect(a).toEqual({ server: 'svc', tool: 'delete_user', args: { id: 7 } })
  })
  it('prefers x-jamjet-server header for server name', () => {
    const a = parseAction(rpc, { 'x-jamjet-server': 'payments-mcp', host: 'svc' }, 'mcp')
    expect(a?.server).toBe('payments-mcp')
  })
  it('returns null for non tools/call methods', () => {
    const other = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(parseAction(other, {}, 'mcp')).toBeNull()
  })
  it('returns null for unparseable bodies', () => {
    expect(parseAction('not json', {}, 'mcp')).toBeNull()
  })
})
