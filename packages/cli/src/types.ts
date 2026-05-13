// Shared types for the Cloud Sync daemon.
//
// AuditEventV1 mirrors `jamjet-policy/conformance/audit-event-shape.json` —
// the same schema validated by `jamjet-cloud-api::policy_audit_v1`. Adapters
// produce these events into `~/.jamjet/audit/<YYYY-MM-DD>/<adapter>.jsonl`;
// the daemon tails them, redacts, and pushes to /v1/policy-audit/events.
//
// OutboxRow, Config, SyncStatus are daemon-internal state.

import { z } from 'zod'

// ─── audit-event-v1 ──────────────────────────────────────────────────────

export const AuditEventV1Schema = z
  .object({
    ts: z.string().datetime({ offset: true }),
    run_id: z.string().regex(/^run_[a-z0-9]+$/),
    trace_id: z.string().nullable().optional(),
    decision_id: z.string().nullable().optional(),
    adapter: z.enum([
      'claude-code-hook',
      'openai-guardrail',
      'mcp-shim',
      'python-sdk',
      'ts-sdk',
    ]),
    host: z.enum([
      'claude-code',
      'claude-desktop',
      'cursor',
      'openai-agents-sdk',
      'python',
      'typescript',
      'custom',
    ]),
    server: z.string().nullable().optional(),
    tool: z.string(),
    args: z.record(z.unknown()).default({}),
    decision: z.enum([
      'ALLOWED',
      'BLOCKED',
      'WAITING_FOR_APPROVAL',
      'APPROVED',
      'REJECTED',
      'BUDGET_EXCEEDED',
      'AUDIT',
      'ERROR',
    ]),
    rule: z.string().nullable().optional(),
    rule_kind: z.enum(['allow', 'block', 'require_approval', 'audit']).nullable().optional(),
    executed: z.boolean(),
    policy_version: z.string().optional(),
    schema_version: z.literal(1),
  })
  .passthrough()

export type AuditEventV1 = z.infer<typeof AuditEventV1Schema>

// ─── outbox ──────────────────────────────────────────────────────────────

export interface OutboxRow {
  id: number
  event_json: string // serialized AuditEventV1 (already redacted)
  ts: string // event ts (for cap-by-age queries)
  attempts: number
  next_attempt_at: number // unix-ms epoch
  inserted_at: number
}

// ─── config ──────────────────────────────────────────────────────────────
//
// API keys minted by jamjet-cloud-api's /v1/cli/authorize use the codebase's
// existing project-key format `jj_<32 hex>` (see jamjet-cloud
// routes::projects::create_project + cli_auth::authorize). Earlier plan
// drafts called the prefix `jjk_live_*`; the actual on-the-wire shape is
// `jj_`, validated below.

export const ConfigSchema = z.object({
  cloud: z.object({
    project_id: z.string().uuid(),
    api_key: z.string().startsWith('jj_'),
    api_base: z.string().url().default('https://api.jamjet.dev'),
    args_redaction: z.enum(['full', 'hash', 'none']).default('full'),
    push: z.enum(['interesting', 'all']).default('interesting'),
    poll_interval_seconds: z.number().min(1).max(60).default(2),
    drainer_interval_seconds: z.number().min(1).max(60).default(1),
    metrics_port: z.number().int().min(1024).max(65535).default(9876),
    metrics_enabled: z.boolean().default(false),
    outbox_max_events: z.number().int().min(100).default(100_000),
    outbox_max_age_days: z.number().int().min(1).default(7),
  }),
})

export type Config = z.infer<typeof ConfigSchema>

// ─── status ──────────────────────────────────────────────────────────────

export interface SyncStatus {
  state: 'ok' | 'offline' | 'degraded' | 'unauthorized' | 'not_running'
  project_id?: string
  daemon_pid?: number
  daemon_started_at?: string
  outbox_depth: number
  outbox_oldest_ts?: string
  last_successful_push_at?: string
  parse_errors_total: number
  http_4xx_total: number
  http_5xx_total: number
  events_pushed_total: number
  events_dropped_total: number // hit cap
  approvals_round_tripped_total: number
}

// ─── decision filter ─────────────────────────────────────────────────────
//
// When `cloud.push: "interesting"` (the default), the tailer only enqueues
// events whose decision is in this set. `ALLOWED` is deliberately excluded —
// the high-volume happy-path doesn't carry incident-investigation value and
// would blow the outbox cap on busy adapters. `push: "all"` overrides this.

export const INTERESTING_DECISIONS: ReadonlyArray<AuditEventV1['decision']> = [
  'BLOCKED',
  'WAITING_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'AUDIT',
  'BUDGET_EXCEEDED',
  'ERROR',
]
