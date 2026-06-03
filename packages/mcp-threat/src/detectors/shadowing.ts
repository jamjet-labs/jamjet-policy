import type { ThreatFinding, ToolDefinition } from '../types.js'

const INVISIBLE = /[­​-‏  ⁠﻿]/g

export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(INVISIBLE, '')
}

/** Detect a single tool name claimed by more than one server. */
export function detectShadowing(serversTools: Record<string, ToolDefinition[]>): ThreatFinding[] {
  const firstOwner = new Map<string, string>()
  const findings: ThreatFinding[] = []
  for (const [server, tools] of Object.entries(serversTools)) {
    for (const t of tools) {
      const key = normalizeName(t.name)
      const owner = firstOwner.get(key)
      if (owner === undefined) {
        firstOwner.set(key, server)
      } else if (owner !== server) {
        findings.push({
          risk_class: 'tool_shadowing',
          server,
          tool: t.name,
          detail: `tool name '${t.name}' collides with a tool already advertised by server '${owner}'`,
        })
      }
    }
  }
  return findings
}
