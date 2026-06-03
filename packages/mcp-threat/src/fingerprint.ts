import { createHash } from 'node:crypto'
import type { ToolDefinition, ToolFingerprint } from './types.js'

/** Deterministic JSON string with object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value) ?? null)
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function sha256Canonical(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value)).digest('hex')
}

export function hashToolDefinition(tool: ToolDefinition): ToolFingerprint {
  return {
    desc_hash: sha256Canonical(tool.description ?? ''),
    schema_hash: sha256Canonical(tool.inputSchema ?? {}),
  }
}
