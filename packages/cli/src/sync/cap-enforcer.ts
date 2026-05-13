// Cap enforcer — keeps the outbox bounded (R7, R8).
//
// Two policies, applied in order each tick:
//   1. Age:  drop everything older than maxAgeDays (default 7d).
//   2. Size: if over maxEvents (default 100k), drop the oldest rows down
//            to the cap.
//
// Every dropped event is appended (with reason) to `dropped.log`, the
// forensic record adapters and operators read when investigating gaps.
// Loss of events is deliberate — pushing memory + disk forever is worse —
// but it must never be silent.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Outbox } from './outbox.js'

export interface CapEnforcerOptions {
  outbox: Outbox
  droppedLogPath: string
  maxEvents: number
  maxAgeDays: number
}

interface DroppedEntry {
  event_json: string
  reason: 'cap_breach' | 'age_exceeded'
}

export class CapEnforcer {
  totalDropped = 0

  constructor(private readonly opts: CapEnforcerOptions) {
    mkdirSync(dirname(opts.droppedLogPath), { recursive: true })
  }

  tick(): number {
    const dropped: DroppedEntry[] = []

    // 1. Age-based: drop everything older than the cutoff.
    const cutoff = new Date(
      Date.now() - this.opts.maxAgeDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    while (true) {
      const oldest = this.opts.outbox.oldestTs()
      if (!oldest || oldest >= cutoff) break
      const more = this.opts.outbox.dropOldest(1)
      if (more.length === 0) break
      for (const event_json of more) {
        dropped.push({ event_json, reason: 'age_exceeded' })
      }
    }

    // 2. Size-based: drop oldest down to the cap.
    const depth = this.opts.outbox.depth()
    if (depth > this.opts.maxEvents) {
      const overage = depth - this.opts.maxEvents
      const more = this.opts.outbox.dropOldest(overage)
      for (const event_json of more) {
        dropped.push({ event_json, reason: 'cap_breach' })
      }
    }

    if (dropped.length > 0) {
      const now = new Date().toISOString()
      const lines = dropped
        .map((d) =>
          JSON.stringify({
            dropped_at: now,
            reason: d.reason,
            event_json: d.event_json,
          }),
        )
        .join('\n') + '\n'
      appendFileSync(this.opts.droppedLogPath, lines, 'utf-8')
      this.totalDropped += dropped.length
    }

    return dropped.length
  }
}
