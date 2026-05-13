// Drainer — periodic loop that pushes outbox rows to Cloud.
//
// Decision tree per tick (R3 + drainer contract):
//   2xx success   → ack rows, advance last_synced_ts to max event ts
//   PermanentError (4xx other than auth)  → ack rows (drop), emit `drop`
//   TransientError (5xx, 408, 429, network) → bumpRetry (exp backoff)
//   HaltedError    (401/403)              → set this.halted, emit `halted`,
//                                            do not delete rows. Subsequent
//                                            ticks are skipped until clear()
//                                            is called (e.g. after a fresh
//                                            `jamjet cloud link`).
import { EventEmitter } from 'node:events'
import type { Outbox } from './outbox.js'
import {
  type CloudClient,
  HaltedError,
  PermanentError,
  TransientError,
} from '../cloud/http.js'
import type { AuditEventV1 } from '../types.js'

export interface DrainerOptions {
  outbox: Outbox
  client: CloudClient
  batchSize: number
}

export class Drainer extends EventEmitter {
  halted = false
  totalPushed = 0
  total4xx = 0
  total5xx = 0
  lastSuccessAt?: string

  constructor(private readonly opts: DrainerOptions) {
    super()
  }

  /** Reset the halt flag — caller signals the auth issue has been resolved. */
  clearHalt(): void {
    this.halted = false
  }

  async tick(): Promise<void> {
    if (this.halted) return

    const rows = this.opts.outbox.dueRows(this.opts.batchSize)
    if (rows.length === 0) return

    // Parse each row defensively. A corrupt event_json blob would otherwise
    // throw synchronously OUTSIDE the try/catch below and the same poison row
    // would block every subsequent tick. Quarantine corrupt rows by acking
    // (treating them like a PermanentError-drop) and continue.
    const events: AuditEventV1[] = []
    const corruptIds: number[] = []
    const goodIds: number[] = []
    for (const r of rows) {
      try {
        events.push(JSON.parse(r.event_json))
        goodIds.push(r.id)
      } catch {
        corruptIds.push(r.id)
      }
    }
    if (corruptIds.length > 0) {
      this.opts.outbox.ack(corruptIds)
      this.total4xx += corruptIds.length
      this.emit('drop', { count: corruptIds.length, status: 0 })
    }
    if (events.length === 0) return

    try {
      const resp = await this.opts.client.postEvents(events)
      this.opts.outbox.ack(goodIds)
      this.totalPushed += resp.accepted + resp.duplicates
      this.lastSuccessAt = new Date().toISOString()
      const maxTs = events.map((e) => e.ts).sort().at(-1)
      if (maxTs) this.opts.outbox.setLastSyncedTs(maxTs)
    } catch (e) {
      if (e instanceof HaltedError) {
        this.halted = true
        this.emit('halted')
        return
      }
      if (e instanceof PermanentError) {
        this.opts.outbox.ack(goodIds)
        this.total4xx++
        this.emit('drop', { count: goodIds.length, status: e.status })
        return
      }
      // TransientError + unknown errors (network drops, DNS, etc.) → retry
      // with backoff. We deliberately do not emit 'error' for unknown errors
      // because EventEmitter throws when 'error' has no listener — that would
      // crash the daemon on a transient blip.
      this.opts.outbox.bumpRetry(goodIds)
      this.total5xx++
      if (!(e instanceof TransientError)) {
        this.emit('unexpected', e)
      }
    }
  }
}
