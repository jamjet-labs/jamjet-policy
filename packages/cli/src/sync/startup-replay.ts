// Startup replay (R12) — closes the miss-window where adapters wrote JSONL
// while the daemon was offline.
//
// On daemon start:
//   1. Read last_synced_ts from the outbox meta table (set by the drainer
//      after each successful 2xx push).
//   2. Walk ~/.jamjet/audit/<date>/*.jsonl in date order.
//   3. For every event with ts > last_synced_ts that passes the filter,
//      enqueue it on the outbox. The normal drainer loop picks it up next.
//
// Cloud's R5 dedup (project_id, run_id, ts, decision) makes this idempotent:
// if the last batch was actually pushed but the daemon crashed before the
// drainer could persist last_synced_ts, replay re-enqueues, the next push
// gets logged as duplicates, and the outbox empties as normal.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AuditEventV1Schema, INTERESTING_DECISIONS } from '../types.js'
import type { Outbox } from './outbox.js'

export interface ReplayOptions {
  outbox: Outbox
  auditDir: string
  filter: 'all' | 'interesting'
}

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/

export async function replayBacklog(opts: ReplayOptions): Promise<number> {
  if (!existsSync(opts.auditDir)) return 0
  const lastSynced = opts.outbox.getLastSyncedTs()
  let count = 0

  const dateDirs = readdirSync(opts.auditDir)
    .filter((name) => DATE_DIR_RE.test(name))
    .sort()

  for (const dateDir of dateDirs) {
    const fullDir = join(opts.auditDir, dateDir)
    try {
      if (!statSync(fullDir).isDirectory()) continue
    } catch {
      continue
    }
    const files = readdirSync(fullDir).filter((f) => f.endsWith('.jsonl'))
    for (const file of files) {
      const path = join(fullDir, file)
      const text = readFileSync(path, 'utf-8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = AuditEventV1Schema.safeParse(raw)
        if (!parsed.success) continue
        const event = parsed.data
        if (lastSynced && event.ts <= lastSynced) continue
        if (
          opts.filter === 'interesting' &&
          !INTERESTING_DECISIONS.includes(event.decision)
        ) {
          continue
        }
        opts.outbox.insert(JSON.stringify(event), event.ts)
        count++
      }
    }
  }

  return count
}
