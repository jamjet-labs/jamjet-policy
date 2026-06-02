import type { ToolDefinition } from '@jamjet/mcp-threat'
import type { JsonRpcMessage } from './jsonrpc.js'

interface ToolsListResult {
  jsonrpc: '2.0'
  id: number | string
  result: { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }
}

export function isToolsListResult(msg: JsonRpcMessage): msg is ToolsListResult {
  const m = msg as { result?: { tools?: unknown } }
  return Boolean(m.result && Array.isArray(m.result.tools))
}

export function extractToolsFromListResponse(msg: JsonRpcMessage): ToolDefinition[] {
  if (!isToolsListResult(msg)) return []
  return msg.result.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}
