import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolvedServer {
  command: string
  args: string[]
  env: Record<string, string>
}

interface McpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface ResolveOptions {
  projectConfig?: string
  userConfig?: string
}

function readMcpServers(path: string): Record<string, McpServerEntry> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null // missing/unreadable file is not an error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`malformed MCP config at ${path}: ${(e as Error).message}`)
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) return servers as Record<string, McpServerEntry>
  return {}
}

export function resolveServerCommand(
  name: string,
  explicitParts?: string[],
  opts?: ResolveOptions,
): ResolvedServer {
  if (explicitParts && explicitParts.length > 0) {
    const [command, ...args] = explicitParts
    if (!command) throw new Error('explicit parts must start with a command')
    return { command, args, env: {} }
  }
  const projectPath = opts?.projectConfig ?? join(process.cwd(), '.mcp.json')
  const userPath = opts?.userConfig ?? join(homedir(), '.mcp.json')
  for (const path of [projectPath, userPath]) {
    const servers = readMcpServers(path)
    const entry = servers?.[name]
    if (entry) {
      if (!entry.command) throw new Error(`server '${name}' in ${path} has no command`)
      return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} }
    }
  }
  throw new Error(`server '${name}' not found in ${projectPath} or ${userPath}; pass -- <cmd> <args>`)
}
