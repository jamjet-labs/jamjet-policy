export type BlastRadius = 'destructive' | 'external_send' | 'write' | 'read' | 'unknown'

// Ordered by severity (highest first). Matched against whole tokens of the
// tool name, so snake_case and camelCase both work and substrings like
// "reset"/"forget" do not false-match "set"/"get".
const BUCKETS: ReadonlyArray<{ radius: BlastRadius; verbs: ReadonlySet<string> }> = [
  { radius: 'destructive', verbs: new Set(['delete', 'drop', 'remove', 'purge', 'truncate', 'destroy', 'rm', 'wipe']) },
  { radius: 'external_send', verbs: new Set(['send', 'post', 'email', 'publish', 'upload', 'notify', 'webhook', 'message']) },
  { radius: 'write', verbs: new Set(['write', 'create', 'update', 'insert', 'set', 'put', 'edit', 'modify', 'save', 'commit', 'push', 'merge', 'append']) },
  { radius: 'read', verbs: new Set(['read', 'get', 'list', 'search', 'query', 'describe', 'stat', 'view', 'fetch', 'find']) },
]

function tokenize(name: string): Set<string> {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const parts = spaced.split(/[^a-zA-Z]+/).filter(Boolean).map((t) => t.toLowerCase())
  return new Set(parts)
}

export function classifyBlastRadius(toolName: string): BlastRadius {
  const tokens = tokenize(toolName)
  for (const { radius, verbs } of BUCKETS) {
    for (const v of verbs) {
      if (tokens.has(v)) return radius
    }
  }
  return 'unknown'
}
