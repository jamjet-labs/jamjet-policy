import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })
const tools = [
  { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
  { name: 'list_dir', description: 'list a dir', inputSchema: { type: 'object' } },
]
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }) + '\n')
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\n')
  }
})
