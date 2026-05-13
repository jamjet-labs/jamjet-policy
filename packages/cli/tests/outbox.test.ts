import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../src/sync/outbox.js'

describe('Outbox', () => {
  let dir: string
  let outbox: Outbox

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jamjet-outbox-test-'))
    outbox = new Outbox(join(dir, 'outbox.db'))
  })

  afterEach(() => {
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and lists pending rows', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"a":2}', '2026-05-12T00:00:01Z')
    expect(outbox.dueRows(10).length).toBe(2)
  })

  it('respects the max-rows limit on dueRows', () => {
    for (let i = 0; i < 200; i++) {
      outbox.insert(`{"i":${i}}`, '2026-05-12T00:00:00Z')
    }
    expect(outbox.dueRows(50).length).toBe(50)
  })

  it('ack removes rows by id', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"a":2}', '2026-05-12T00:00:01Z')
    const rows = outbox.dueRows(10)
    outbox.ack([rows[0].id])
    expect(outbox.dueRows(10).length).toBe(1)
  })

  it('bumpRetry increments attempts and pushes next_attempt_at into the future', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    const [before] = outbox.dueRows(1)
    outbox.bumpRetry([before.id])
    const [after] = outbox.dueRows(1, { ignoreSchedule: true })
    expect(after.next_attempt_at).toBeGreaterThan(before.next_attempt_at)
    expect(after.attempts).toBe(1)
  })

  it('bumpRetry caps backoff at 60s even for very-late retries', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    const [row] = outbox.dueRows(1)
    // 15 consecutive failures would yield 2^15 = 32768s without the cap.
    for (let i = 0; i < 15; i++) outbox.bumpRetry([row.id])
    const [retried] = outbox.dueRows(1, { ignoreSchedule: true })
    // Cap is 60s × jitter (≤ 1.5) → 90s ceiling from now.
    const msFromNow = retried.next_attempt_at - Date.now()
    expect(msFromNow).toBeLessThanOrEqual(60_000 * 1.5 + 100)
    expect(retried.attempts).toBe(15)
  })

  it('depth returns the total row count', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"a":2}', '2026-05-12T00:00:01Z')
    expect(outbox.depth()).toBe(2)
  })

  it('oldestTs returns the earliest event ts', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"a":2}', '2026-05-11T23:59:00Z')
    expect(outbox.oldestTs()).toBe('2026-05-11T23:59:00Z')
  })

  it('dropOldest removes N rows ordered by ts and returns their event_json', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    outbox.insert('{"a":2}', '2026-05-11T00:00:00Z')
    outbox.insert('{"a":3}', '2026-05-10T00:00:00Z')
    const dropped = outbox.dropOldest(2)
    expect(dropped.length).toBe(2)
    expect(JSON.parse(dropped[0]).a).toBe(3) // 2026-05-10 is oldest
    expect(JSON.parse(dropped[1]).a).toBe(2)
    expect(outbox.depth()).toBe(1)
  })

  it('lastSyncedTs persists across Outbox instances on the same file', () => {
    outbox.setLastSyncedTs('2026-05-12T00:00:00Z')
    expect(outbox.getLastSyncedTs()).toBe('2026-05-12T00:00:00Z')

    outbox.close()
    const reopened = new Outbox(join(dir, 'outbox.db'))
    try {
      expect(reopened.getLastSyncedTs()).toBe('2026-05-12T00:00:00Z')
    } finally {
      reopened.close()
    }
  })
})
