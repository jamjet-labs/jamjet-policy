import type { AgentPrincipal } from '@jamjet/cedar'

export interface AuthzAction {
  server: string
  tool: string
  args: Record<string, unknown>
  /** The caller, when the enforcement point identifies one. Binds holds to it. */
  principal?: AgentPrincipal
  /** Risk label asserted by the enforcement point (AuthZen context.risk). */
  risk?: string
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
