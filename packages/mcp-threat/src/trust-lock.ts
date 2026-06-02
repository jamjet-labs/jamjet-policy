import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolDefinition, TrustBaseline } from './types.js'
import { hashToolDefinition } from './fingerprint.js'

export function defaultTrustLockPath(): string {
  return join(homedir(), '.jamjet', 'mcp-trust.lock')
}

export function loadTrustBaseline(path: string = defaultTrustLockPath()): TrustBaseline {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as TrustBaseline
    if (parsed && parsed.version === 1 && parsed.servers) return parsed
  } catch {
    // missing or unreadable -> empty baseline
  }
  return { version: 1, servers: {} }
}

export function saveTrustBaseline(path: string, baseline: TrustBaseline): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n', 'utf-8')
}

export function approveServer(
  baseline: TrustBaseline,
  server: string,
  fingerprint: string,
  tools: ToolDefinition[],
  approvedAt: string,
): TrustBaseline {
  const toolHashes: Record<string, ReturnType<typeof hashToolDefinition>> = {}
  for (const t of tools) toolHashes[t.name] = hashToolDefinition(t)
  return {
    ...baseline,
    servers: {
      ...baseline.servers,
      [server]: { fingerprint, approved_at: approvedAt, tools: toolHashes },
    },
  }
}
