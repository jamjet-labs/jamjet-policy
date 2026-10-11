/**
 * Structural checks on raw JSON-RPC objects, applied before any policy logic.
 *
 * Parsers disagree on edge cases, and a shim is only safe when it and the
 * server read a message the same way. Two disagreements matter here:
 * - Depth: a deeply nested value overflows recursive code (hashing, JSON
 *   serialisation) and a scan limit that silently stops is a blind spot.
 * - Key case: Go's encoding/json matches object keys case-insensitively, so
 *   `"Name"` next to `"name"` (or `"Method"` alone) can be read differently by
 *   the shim and the server.
 */

/** True when `value` nests deeper than `limit` (iterative, so it cannot overflow). */
export function depthExceeds(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]]
  while (stack.length > 0) {
    const [v, d] = stack.pop()!
    if (!v || typeof v !== 'object') continue
    if (d >= limit) return true
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)
    for (const c of children) if (c && typeof c === 'object') stack.push([c, d + 1])
  }
  return false
}

/**
 * Return a key that another parser could confuse with a different one: two keys
 * equal ignoring case, or a case variant of a known member name. Null when clean.
 */
export function caseConfusableKey(obj: Record<string, unknown>, known: readonly string[]): string | null {
  const knownLower = new Map(known.map((k) => [k.toLowerCase(), k]))
  const seen = new Set<string>()
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase()
    if (seen.has(lower)) return key
    seen.add(lower)
    const canonical = knownLower.get(lower)
    if (canonical !== undefined && canonical !== key) return key
  }
  return null
}

export function isValidId(id: unknown): id is string | number {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

/** Map key that keeps 3 and "3" apart. */
export function idKey(id: string | number): string {
  return `${typeof id}:${String(id)}`
}
