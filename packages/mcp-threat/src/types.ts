/** A single tool as advertised by an MCP server in a tools/list result. */
export interface ToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Per-tool content-addressed fingerprint. */
export interface ToolFingerprint {
  desc_hash: string
  schema_hash: string
}

/** One approved server in the trust baseline. */
export interface ServerFingerprint {
  /** Identity hash (e.g. of command+args or URL). */
  fingerprint: string
  approved_at: string
  tools: Record<string, ToolFingerprint>
}

/** ~/.jamjet/mcp-trust.lock on disk. */
export interface TrustBaseline {
  version: 1
  servers: Record<string, ServerFingerprint>
}

export type ThreatRiskClass =
  | 'first_seen'
  | 'tool_definition_drift'
  | 'tool_shadowing'
  | 'token_passthrough'

/** Actions a threat config can map a risk class to (Plan 1 set). */
export type ThreatAction = 'block' | 'require_approval' | 'audit' | 'allow'

/** Decisions, identical enum to the shim's existing decision vocabulary. */
export type Decision = 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'AUDIT'

export interface ThreatFinding {
  risk_class: ThreatRiskClass
  server: string
  tool: string | null
  detail: string
  baseline_hash?: string
  observed_hash?: string
}

export interface ThreatConfig {
  on_first_seen: ThreatAction
  on_definition_drift: ThreatAction
  on_tool_shadow: ThreatAction
  on_token_passthrough: ThreatAction
}

export interface ThreatDecision {
  decision: Decision
  finding: ThreatFinding | null
}

/** MCP Security Receipt: a profile of an AgentBoundary receipt. */
export interface McpSecurityReceipt {
  version: string
  issued_at: string
  server: string
  tool: string | null
  action: 'tools/call' | 'tools/list'
  policy: { decision: Decision; risk_class: ThreatRiskClass }
  finding: ThreatRiskClass
  detail: string
  risk_class: ThreatRiskClass
  baseline_hash?: string
  observed_hash?: string
  receipt_hash: string
}
