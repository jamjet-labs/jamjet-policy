import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }) + '\n')
  }
  // intentionally never answers tools/list
})
