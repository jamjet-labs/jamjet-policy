#!/usr/bin/env node
// Minimal MCP client: connects to agentgateway over Streamable HTTP and calls one tool.
// Usage: node client.mjs <tool> [json-args]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.GATEWAY_URL ?? 'http://localhost:3000/mcp'
const tool = process.argv[2]
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
if (!tool) {
  console.error('usage: node client.mjs <tool> [json-args]')
  process.exit(2)
}

const client = new Client({ name: 'jamjet-demo-client', version: '0.1.0' })
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  const result = await client.callTool({ name: tool, arguments: args })
  const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ')
  console.log(`ALLOWED ${tool}: ${text.slice(0, 120)}`)
  process.exit(0)
} catch (err) {
  const msg = String(err?.message ?? err)
  if (msg.includes('approval_required') || msg.includes('insufficient_scope')) {
    console.log(`PENDING ${tool}: approval required`)
    process.exit(3)
  }
  if (msg.includes('403') || msg.toLowerCase().includes('forbidden') || msg.includes('blocked')) {
    console.log(`BLOCKED ${tool}: ${msg.slice(0, 160)}`)
    process.exit(4)
  }
  console.error(`ERROR ${tool}: ${msg.slice(0, 300)}`)
  process.exit(1)
} finally {
  await client.close().catch(() => {})
}
