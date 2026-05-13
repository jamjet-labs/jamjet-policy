// Args redaction.
//
// The R9 invariant says args content stays on the user's machine by default.
// The daemon applies the configured redaction mode AFTER reading a JSONL line
// and BEFORE writing the row to the SQLite outbox — so anything that makes it
// into the outbox already conforms to the redaction setting.
//
//   full → args = { redacted: true }              (default; no content leaves the box)
//   hash → args = { redacted: true, sha256: hex } (stable hash; lets ops correlate
//                                                  identical calls without leaking args)
//   none → args is passed through verbatim         (only when an operator opts in)
//
// stableStringify normalizes key order so two payloads with the same content
// but different serialization order produce the same hash.

import { createHash } from 'node:crypto'
import type { AuditEventV1 } from '../types.js'

export type RedactionMode = 'full' | 'hash' | 'none'

export function applyRedaction(
  event: AuditEventV1,
  mode: RedactionMode,
): AuditEventV1 & { args_redaction: RedactionMode } {
  switch (mode) {
    case 'none':
      return { ...event, args_redaction: 'none' }
    case 'full':
      return { ...event, args: { redacted: true }, args_redaction: 'full' }
    case 'hash': {
      const stable = stableStringify(event.args ?? {})
      const sha256 = createHash('sha256').update(stable).digest('hex')
      return { ...event, args: { redacted: true, sha256 }, args_redaction: 'hash' }
    }
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}
