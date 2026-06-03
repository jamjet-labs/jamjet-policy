export type BlastRadius = 'destructive' | 'external_send' | 'write' | 'read' | 'unknown'

// First match wins, ordered by severity (highest first).
const PATTERNS: ReadonlyArray<{ radius: BlastRadius; re: RegExp }> = [
  { radius: 'destructive', re: /delete|drop|remove|purge|truncate|destroy|\brm\b|wipe/i },
  { radius: 'external_send', re: /send|post|email|publish|upload|notify|webhook|message/i },
  { radius: 'write', re: /write|create|update|insert|\bset\b|\bput\b|edit|modify|save|commit|push|merge|append/i },
  { radius: 'read', re: /read|\bget\b|list|search|query|describe|stat|view|fetch|find/i },
]

export function classifyBlastRadius(toolName: string): BlastRadius {
  for (const { radius, re } of PATTERNS) {
    if (re.test(toolName)) return radius
  }
  return 'unknown'
}
