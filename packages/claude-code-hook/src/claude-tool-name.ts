// src/claude-tool-name.ts
// Claude Code surfaces MCP tools as `mcp__<server>__<tool>`. Strip the prefix
// for policy matching so user policies can be MCP-server-agnostic.

export interface ParsedToolName {
  raw: string
  effective: string
  server: string | null
}

export function parseClaudeToolName(raw: string): ParsedToolName {
  const match = raw.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
  if (!match) {
    return { raw, effective: raw, server: null }
  }
  return { raw, effective: match[2]!, server: match[1]! }
}
