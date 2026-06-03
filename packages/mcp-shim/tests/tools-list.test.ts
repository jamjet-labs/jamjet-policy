import { describe, it, expect } from 'vitest'
import { extractToolsFromListResponse, isToolsListResult } from '../src/tools-list.js'

describe('isToolsListResult', () => {
  it('detects a tools/list result message', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, result: { tools: [{ name: 'a' }] } }
    expect(isToolsListResult(msg)).toBe(true)
  })
  it('ignores non-list responses', () => {
    expect(isToolsListResult({ jsonrpc: '2.0' as const, id: 1, result: { content: [] } })).toBe(false)
    expect(isToolsListResult({ jsonrpc: '2.0' as const, method: 'tools/call' })).toBe(false)
  })
  it('ignores a message with tools but no id', () => {
    expect(isToolsListResult({ jsonrpc: '2.0' as const, result: { tools: [{ name: 'a' }] } } as any)).toBe(false)
  })
})

describe('extractToolsFromListResponse', () => {
  it('maps the result.tools array into ToolDefinition[]', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, result: { tools: [
      { name: 'read_file', description: 'd', inputSchema: { type: 'object' } },
      { name: 'no_schema' },
    ] } }
    expect(extractToolsFromListResponse(msg)).toEqual([
      { name: 'read_file', description: 'd', inputSchema: { type: 'object' } },
      { name: 'no_schema', description: undefined, inputSchema: undefined },
    ])
  })
  it('returns [] when there is no tools array', () => {
    expect(extractToolsFromListResponse({ jsonrpc: '2.0' as const, id: 1, result: {} })).toEqual([])
  })
})
