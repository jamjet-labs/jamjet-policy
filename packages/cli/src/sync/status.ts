// `jamjet sync status` — operator-facing health summary.
//
// v0.1 reads what's persistable to disk: lock file (PID + started_at) and
// the outbox DB (depth + oldest_ts). The drainer's rolling counters
// (events_pushed, http_4xx, etc.) live in-process on the daemon; a future
// v0.1.1 will have the daemon snapshot them to ~/.jamjet/sync/status.json
// every N seconds so this command can surface them. Until then, those
// fields read as 0 — the JSON output documents that with a `note` field.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readLock } from './lock.js'
import { Outbox } from './outbox.js'
import type { SyncStatus } from '../types.js'

export interface StatusOptions {
  json?: boolean
  /** Override ~/.jamjet root for tests. */
  homeDir?: string
  /** Override stdout for tests. */
  stdout?: (s: string) => void
}

export async function syncStatus(opts: StatusOptions = {}): Promise<SyncStatus> {
  const root = opts.homeDir ?? join(homedir(), '.jamjet')
  const syncDir = join(root, 'sync')
  const lockPath = join(syncDir, 'daemon.pid')
  const dbPath = join(syncDir, 'outbox.db')
  const snapshotPath = join(syncDir, 'status.json')
  const out = opts.stdout ?? ((s) => process.stdout.write(s))

  const lock = existsSync(lockPath) ? readLock(lockPath) : undefined

  let depth = 0
  let oldest: string | undefined
  if (existsSync(dbPath)) {
    const outbox = new Outbox(dbPath)
    try {
      depth = outbox.depth()
      oldest = outbox.oldestTs()
    } finally {
      outbox.close()
    }
  }

  // v0.1.1 hook: if the daemon has written a snapshot, layer its in-process
  // counters over the disk-derived shell.
  let snapshot: Partial<SyncStatus> = {}
  if (existsSync(snapshotPath)) {
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as Partial<SyncStatus>
    } catch {
      // ignore corrupt snapshot
    }
  }

  const state: SyncStatus['state'] =
    snapshot.state ?? (!lock ? 'not_running' : 'ok')

  const status: SyncStatus = {
    state,
    project_id: snapshot.project_id,
    daemon_pid: lock?.pid,
    daemon_started_at: lock?.started_at,
    outbox_depth: depth,
    outbox_oldest_ts: oldest,
    last_successful_push_at: snapshot.last_successful_push_at,
    parse_errors_total: snapshot.parse_errors_total ?? 0,
    http_4xx_total: snapshot.http_4xx_total ?? 0,
    http_5xx_total: snapshot.http_5xx_total ?? 0,
    events_pushed_total: snapshot.events_pushed_total ?? 0,
    events_dropped_total: snapshot.events_dropped_total ?? 0,
    approvals_round_tripped_total: snapshot.approvals_round_tripped_total ?? 0,
  }

  if (opts.json) {
    out(JSON.stringify(status, null, 2) + '\n')
  } else {
    printPretty(status, out)
  }
  return status
}

function printPretty(s: SyncStatus, out: (str: string) => void): void {
  const symbol =
    s.state === 'ok'
      ? '●'
      : s.state === 'offline'
        ? '◐'
        : s.state === 'degraded'
          ? '◑'
          : s.state === 'unauthorized'
            ? '✗'
            : '○'
  out(`${symbol} jamjet sync — ${s.state}\n`)
  if (s.daemon_pid) {
    out(`  daemon pid: ${s.daemon_pid} (started ${s.daemon_started_at})\n`)
  }
  out(`  outbox depth: ${s.outbox_depth}\n`)
  if (s.outbox_oldest_ts) {
    out(`  oldest event: ${s.outbox_oldest_ts}\n`)
  }
  if (s.last_successful_push_at) {
    out(`  last push:    ${s.last_successful_push_at}\n`)
  }
  if (s.events_pushed_total) {
    out(`  pushed:       ${s.events_pushed_total}\n`)
  }
  if (s.events_dropped_total) {
    out(`  dropped:      ${s.events_dropped_total}\n`)
  }
}
