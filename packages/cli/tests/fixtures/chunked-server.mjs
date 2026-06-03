import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, terminal: false })
const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }) + '\n')
  } else if (msg.method === 'tools/list') {
    const full = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\n'
    const mid = Math.floor(full.length / 2)
    process.stdout.write(full.slice(0, mid))
    setTimeout(() => process.stdout.write(full.slice(mid)), 20)
  }
})
