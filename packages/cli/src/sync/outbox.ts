// SQLite-backed outbox for the Cloud Sync daemon.
//
// Append-only queue of JSONL-derived audit events that haven't yet been
// pushed to Cloud. The drainer reads ready rows, posts them to
// /v1/policy-audit/events, then calls ack(ids) on success or bumpRetry(ids)
// on failure. The cap-enforcer calls dropOldest(n) when depth() > config max.
//
// Storage layout:
//   outbox    (id, event_json, ts, attempts, next_attempt_at, inserted_at)
//   meta      key/value table — currently holds `last_synced_ts` for R12
//             startup-replay (so we can replay from the JSONL files only
//             from the last successful push forward, not the whole history).
//
// WAL mode + synchronous=NORMAL is the typical SQLite tuning for a
// single-writer queue; sync data loss on power-cut is bounded by one
// transaction at most, which the drainer treats as a duplicate-and-retry.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface OutboxRow {
  id: number
  event_json: string
  ts: string
  attempts: number
  next_attempt_at: number
  inserted_at: number
}

const BACKOFF_CAP_SECONDS = 60

export class Outbox {
  private db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json      TEXT NOT NULL,
        ts              TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        inserted_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_next_attempt_idx ON outbox (next_attempt_at);
      CREATE INDEX IF NOT EXISTS outbox_ts_idx ON outbox (ts);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  /** Add a row to the outbox. Returns the new row's id. */
  insert(eventJson: string, ts: string): number {
    const now = Date.now()
    const info = this.db
      .prepare(
        'INSERT INTO outbox (event_json, ts, attempts, next_attempt_at, inserted_at) VALUES (?, ?, 0, ?, ?)',
      )
      .run(eventJson, ts, now, now)
    return Number(info.lastInsertRowid)
  }

  /**
   * Read up to `limit` rows ready to be pushed (next_attempt_at <= now).
   * Use `{ ignoreSchedule: true }` to read rows regardless of their backoff
   * schedule — useful in tests and for shutdown drain.
   */
  dueRows(limit: number, opts: { ignoreSchedule?: boolean } = {}): OutboxRow[] {
    if (opts.ignoreSchedule) {
      return this.db
        .prepare('SELECT * FROM outbox ORDER BY id ASC LIMIT ?')
        .all(limit) as OutboxRow[]
    }
    return this.db
      .prepare('SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY id ASC LIMIT ?')
      .all(Date.now(), limit) as OutboxRow[]
  }

  /** Delete acknowledged rows (called after a successful push). */
  ack(ids: number[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM outbox WHERE id IN (${placeholders})`).run(...ids)
  }

  /**
   * Mark rows as failed: increment attempts, push next_attempt_at into the
   * future with exponential backoff (cap 60s) and ±50% jitter. The jitter
   * spreads retries across daemons that started together (e.g. after a
   * Cloud outage ends).
   */
  bumpRetry(ids: number[]): void {
    if (ids.length === 0) return
    const tx = this.db.transaction((idArr: number[]) => {
      const select = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?')
      const update = this.db.prepare(
        'UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?',
      )
      for (const id of idArr) {
        const row = select.get(id) as { attempts: number } | undefined
        if (!row) continue
        const nextAttempts = row.attempts + 1
        const backoffSec = Math.min(Math.pow(2, nextAttempts), BACKOFF_CAP_SECONDS)
        const backoffMs = backoffSec * 1000 * jitter()
        update.run(nextAttempts, Date.now() + backoffMs, id)
      }
    })
    tx(ids)
  }

  /** Total rows in the outbox (used by cap-enforcer + status). */
  depth(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }
    return r.n
  }

  /** Earliest event ts still queued; undefined if outbox is empty. */
  oldestTs(): string | undefined {
    const r = this.db
      .prepare('SELECT ts FROM outbox ORDER BY ts ASC LIMIT 1')
      .get() as { ts: string } | undefined
    return r?.ts
  }

  /**
   * Drop the N oldest rows; return their event_json so the cap-enforcer can
   * append them to `~/.jamjet/sync/dropped.log` for human auditability (R7).
   */
  dropOldest(n: number): string[] {
    const rows = this.db
      .prepare('SELECT id, event_json FROM outbox ORDER BY ts ASC LIMIT ?')
      .all(n) as Array<{ id: number; event_json: string }>
    if (rows.length === 0) return []
    const placeholders = rows.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM outbox WHERE id IN (${placeholders})`).run(...rows.map((r) => r.id))
    return rows.map((r) => r.event_json)
  }

  /** Read the persisted last-synced timestamp (R12 startup-replay key). */
  getLastSyncedTs(): string | undefined {
    const r = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_synced_ts'")
      .get() as { value: string } | undefined
    return r?.value
  }

  /** Persist last-synced ts. Called by the drainer after each successful push. */
  setLastSyncedTs(ts: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_synced_ts', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(ts, ts)
  }

  close(): void {
    this.db.close()
  }
}

function jitter(): number {
  return 0.5 + Math.random() // [0.5, 1.5)
}
