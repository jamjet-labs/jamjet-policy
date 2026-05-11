// Tiny MCP server that echoes any tools/call by id with a synthetic result.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `executed ${msg.params.name}` }] },
      }) + '\n')
    } else if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2025-03-26', capabilities: {} },
      }) + '\n')
    }
  } catch {}
})
