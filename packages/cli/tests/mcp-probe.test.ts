import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { probeServerTools } from '../src/mcp/probe.js'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('probeServerTools', () => {
  it('returns the advertised tools mapped to ToolDefinition[]', async () => {
    const tools = await probeServerTools({ command: 'node', args: [fixture('fake-list-server.mjs')], env: {} })
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'list_dir'])
    expect(tools[0]?.description).toBe('read a file')
    expect(tools[0]?.inputSchema).toEqual({ type: 'object' })
  })

  it('rejects with a timeout when tools/list stalls', async () => {
    await expect(
      probeServerTools({ command: 'node', args: [fixture('silent-server.mjs')], env: {}, timeoutMs: 400 }),
    ).rejects.toThrow(/within/)
  })

  it('rejects with a not-found message for a missing command', async () => {
    await expect(
      probeServerTools({ command: 'definitely-not-a-real-binary-xyz', args: [], env: {} }),
    ).rejects.toThrow(/not found/)
  })
})
