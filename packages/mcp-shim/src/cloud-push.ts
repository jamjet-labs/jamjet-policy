// Path B direct-push helper for the MCP shim.
//
// Constructs a CloudPusher from env when detect_path_mode()==='direct',
// applies args redaction (R9: default `full`) before push, and pushes
// fire-and-forget so the JSON-RPC proxy path is never blocked by Cloud.
//
// trace_id for MCP requests comes from the proposed `_meta.traceparent`
// field on the JSON-RPC params object (per the MCP spec's metadata
// extension point). When absent, the OTel current span / OTEL_TRACE_ID
// env are also probed by @jamjet/cloud's readTraceparent.

import {
  CloudPusher,
  detectPathMode,
  parseTraceparent,
  readTraceparent,
  type CloudPusherEvent,
} from '@jamjet/cloud'
import { createHash } from 'node:crypto'

export type ArgsRedactionMode = 'full' | 'hash' | 'none'

export function resolveArgsRedaction(explicit?: ArgsRedactionMode): ArgsRedactionMode {
  if (explicit) return explicit
  const env = (process.env.JAMJET_ARGS_REDACTION ?? '').toLowerCase()
  if (env === 'full' || env === 'hash' || env === 'none') return env
  return 'full'
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

export function redactArgs(
  args: Record<string, unknown>,
  mode: ArgsRedactionMode,
): { args: Record<string, unknown>; args_redaction: ArgsRedactionMode } {
  if (mode === 'none') return { args, args_redaction: 'none' }
  if (mode === 'full') return { args: { redacted: true }, args_redaction: 'full' }
  const sha256 = createHash('sha256').update(stableStringify(args)).digest('hex')
  return { args: { redacted: true, sha256 }, args_redaction: 'hash' }
}

export function buildCloudPusher(): CloudPusher | null {
  if (detectPathMode() !== 'direct') return null
  const apiKey = process.env.JAMJET_CLOUD_TOKEN
  if (!apiKey) return null
  return new CloudPusher({
    apiBase: process.env.JAMJET_API_BASE ?? 'https://api.jamjet.dev',
    apiKey,
  })
}

/**
 * Extract trace_id from an MCP JSON-RPC request's params._meta.traceparent
 * (the proposed MCP metadata field), then fall back to readTraceparent's
 * other sources (OTel current span, OTEL_TRACE_ID env).
 */
export function traceIdFromMcpRequest(params: unknown): string | undefined {
  if (params && typeof params === 'object') {
    const meta = (params as Record<string, unknown>)._meta
    if (meta && typeof meta === 'object') {
      const raw = (meta as Record<string, unknown>).traceparent
      const parsed = typeof raw === 'string' ? parseTraceparent(raw) : null
      if (parsed) return parsed.trace_id
    }
  }
  const fallback = readTraceparent()
  return fallback?.trace_id
}

export interface PushOptions {
  pusher: CloudPusher
  run_id: string
  serverName: string
  tool: string
  args: Record<string, unknown>
  decision: 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL' | 'APPROVED' | 'REJECTED' | 'AUDIT' | 'ERROR'
  rule: string | null
  rule_kind: 'allow' | 'block' | 'require_approval' | 'audit' | null
  executed: boolean
  trace_id?: string
  redactionMode: ArgsRedactionMode
}

/** Build a redacted CloudPusherEvent and fire-and-forget push it. Never throws. */
export function pushAuditEvent(opts: PushOptions): void {
  const { args, args_redaction } = redactArgs(opts.args, opts.redactionMode)
  const event: CloudPusherEvent = {
    ts: new Date().toISOString(),
    run_id: opts.run_id,
    adapter: 'mcp-shim',
    host: 'claude-desktop',
    server: opts.serverName,
    tool: opts.tool,
    decision: opts.decision,
    executed: opts.executed,
    schema_version: 1,
    args,
    args_redaction,
    trace_id: opts.trace_id ?? null,
    rule: opts.rule ?? null,
    rule_kind: opts.rule_kind,
  }
  void opts.pusher.push(event).catch(() => {})
}
