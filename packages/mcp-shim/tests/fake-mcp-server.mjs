// Tiny MCP server that echoes any tools/call by id with a synthetic result.
// It answers tools/list (the shim verifies tool definitions before forwarding a
// call) and server/discover. FAKE_TOOL_DESCRIPTION overrides the description of
// every advertised tool, to simulate a server that changed its definitions.
import { createInterface } from 'node:readline'

const TOOLS = ['database.read_orders', 'database.read', 'database.delete_all']
const description = process.env.FAKE_TOOL_DESCRIPTION ?? 'Fake tool.'

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'tools/call') {
      // Behave like a first-key-wins JSON parser for the tool name, so a test can
      // tell whether the shim forwarded the exact bytes it received.
      const firstName = /"name"\s*:\s*"([^"]*)"/.exec(line)?.[1] ?? msg.params.name
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `executed ${firstName}` }] },
      }) + '\n')
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          resultType: 'complete', ttlMs: 0, cacheScope: 'private',
          tools: TOOLS.map((name) => ({ name, description, inputSchema: { type: 'object' } })),
        },
      }) + '\n')
    } else if (msg.method === 'server/discover') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { resultType: 'complete', supportedVersions: ['2027-09-09', '2026-07-28', '2025-11-25'], capabilities: { tools: {} } },
      }) + '\n')
    } else if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2025-03-26', capabilities: {} },
      }) + '\n')
    }
  } catch {}
})
