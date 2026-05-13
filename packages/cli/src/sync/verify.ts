// `jamjet sync verify <YYYY-MM-DD>` — R4 drift detection.
//
// v0.1 LIMITATION: B1 does not expose a "list event run_ids for date X"
// read endpoint. So in v0.1, verify reports only the LOCAL count and runs
// a self-consistency check (every JSONL row parses + passes schema).
// The cloud/missing/extra fields stay empty.
//
// v0.2 follow-up (Plan B1.1): add GET /v1/policy-audit/events?from=&to=
// returning {run_id, ts, decision} tuples. With that, this function joins
// local ∪ cloud and surfaces real drift.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuditEventV1Schema, INTERESTING_DECISIONS } from '../types.js'

export interface VerifyOptions {
  date: string
  skewMinutes?: number
  homeDir?: string
}

export interface VerifyResult {
  date: string
  local: number
  local_parse_errors: number
  cloud: number
  missing_in_cloud: string[]
  extra_in_cloud: string[]
  cloud_query_supported: boolean
}

export async function syncVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const skewMs = (opts.skewMinutes ?? 5) * 60 * 1000
  const cutoff = new Date(Date.now() - skewMs).toISOString()

  const root = opts.homeDir ?? join(homedir(), '.jamjet')
  const auditDir = join(root, 'audit', opts.date)

  const localRunIds = new Set<string>()
  let parseErrors = 0

  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'))) {
      const text = readFileSync(join(auditDir, f), 'utf-8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          parseErrors++
          continue
        }
        const parsed = AuditEventV1Schema.safeParse(raw)
        if (!parsed.success) {
          parseErrors++
          continue
        }
        const ev = parsed.data
        if (!INTERESTING_DECISIONS.includes(ev.decision)) continue
        if (ev.ts > cutoff) continue
        localRunIds.add(ev.run_id)
      }
    }
  }

  return {
    date: opts.date,
    local: localRunIds.size,
    local_parse_errors: parseErrors,
    cloud: 0,
    missing_in_cloud: [],
    extra_in_cloud: [],
    cloud_query_supported: false,
  }
}
