export interface AuthzAction {
  server: string
  tool: string
  args: Record<string, unknown>
}

export type PolicyVerdict =
  | { kind: 'ALLOW'; matchedPattern: string | null }
  | { kind: 'BLOCK'; matchedPattern: string | null; reason: string }
  | { kind: 'PENDING'; matchedPattern: string | null }

export interface AuthzHttpResult {
  status: number
  headers: Record<string, string>
  body: string
}
