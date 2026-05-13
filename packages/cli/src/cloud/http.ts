// Cloud client — undici-based HTTP wrapper for /v1/policy-audit/* + /v1/cli/*.
//
// Error taxonomy (R3 + drainer contract):
//   - HaltedError    (401/403)   — daemon must stop pushing until `jamjet cloud link`
//                                  rotates the key. Caller drops to `unauthorized` state.
//   - TransientError (5xx, 408, 429) — retry with backoff; row stays in outbox.
//   - PermanentError (other 4xx) — drop the event; log + advance the outbox cursor.
//
// The wire shape mirrors `jamjet-cloud-api::routes::policy_audit`. The B1 batch
// endpoint deserializes `{ events: [...] }`; we additionally tag `path` so the
// server can split daemon vs direct-push telemetry (extra fields are ignored
// by serde, so this is forward-safe).
import { request } from 'undici'
import type { AuditEventV1 } from '../types.js'

export interface CloudClientOptions {
  apiBase: string
  apiKey: string
  userAgent?: string
  pathMode?: 'daemon' | 'direct'
}

export interface IngestResponse {
  accepted: number
  rejected: number
  duplicates: number
  errors: Array<{ index: number; error: string }>
}

export interface ApprovalDecision {
  run_id: string
  status: 'APPROVED' | 'REJECTED' | 'EXPIRED'
  decided_at?: string
  decided_by?: string
  reason?: string | null
}

export class TransientError extends Error {
  readonly kind = 'retry' as const
}

export class PermanentError extends Error {
  readonly kind = 'drop' as const
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
  }
}

export class HaltedError extends Error {
  readonly kind = 'halt' as const
}

const DEFAULT_UA = '@jamjet/cli sync'

export class CloudClient {
  constructor(private readonly opts: CloudClientOptions) {}

  async postEvents(events: AuditEventV1[]): Promise<IngestResponse> {
    const url = `${this.opts.apiBase}/v1/policy-audit/events`
    const body = JSON.stringify({ events, path: this.opts.pathMode ?? 'daemon' })
    const { statusCode, body: respBody } = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        'user-agent': this.opts.userAgent ?? DEFAULT_UA,
      },
      body,
    })
    const text = await respBody.text()
    if (statusCode === 401 || statusCode === 403) {
      throw new HaltedError(`auth halted: ${statusCode}`)
    }
    if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
      throw new TransientError(`HTTP ${statusCode}: ${text}`)
    }
    if (statusCode >= 400) {
      throw new PermanentError(`HTTP ${statusCode}: ${text}`, statusCode)
    }
    try {
      return JSON.parse(text) as IngestResponse
    } catch {
      throw new TransientError(`200 OK but body is not valid JSON: ${text.slice(0, 200)}`)
    }
  }

  async approvalsPending(runIds: string[]): Promise<ApprovalDecision[]> {
    if (runIds.length === 0) return []
    const url = `${this.opts.apiBase}/v1/policy-audit/approvals/pending?run_ids=${encodeURIComponent(runIds.join(','))}`
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'user-agent': this.opts.userAgent ?? DEFAULT_UA,
      },
    })
    const text = await body.text()
    if (statusCode === 401 || statusCode === 403) {
      throw new HaltedError(`auth halted: ${statusCode}`)
    }
    if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
      throw new TransientError(`HTTP ${statusCode}: ${text}`)
    }
    if (statusCode >= 400) {
      throw new PermanentError(`HTTP ${statusCode}: ${text}`, statusCode)
    }
    try {
      return JSON.parse(text) as ApprovalDecision[]
    } catch {
      throw new TransientError(`200 OK but body is not valid JSON: ${text.slice(0, 200)}`)
    }
  }
}
