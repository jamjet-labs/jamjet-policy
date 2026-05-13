import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../src/sync/outbox.js'
import { Drainer } from '../src/sync/drainer.js'
import { HaltedError, PermanentError, TransientError, type CloudClient } from '../src/cloud/http.js'

function mkOutbox() {
  const dir = mkdtempSync(join(tmpdir(), 'jamjet-drainer-'))
  const outbox = new Outbox(join(dir, 'out.db'))
  return {
    outbox,
    cleanup: () => {
      outbox.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function fakeEvent(rid = 'run_a', ts = '2026-05-12T00:00:00.000Z') {
  return JSON.stringify({
    ts,
    run_id: rid,
    adapter: 'openai-guardrail',
    host: 'openai-agents-sdk',
    tool: 'x.y',
    decision: 'BLOCKED',
    executed: false,
    schema_version: 1,
    args: { redacted: true },
    args_redaction: 'full',
  })
}

describe('Drainer', () => {
  it('acks rows on 2xx', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1', '2026-05-12T00:00:00.000Z'), '2026-05-12T00:00:00.000Z')
    outbox.insert(fakeEvent('run_2', '2026-05-12T00:00:01.000Z'), '2026-05-12T00:00:01.000Z')

    const client = {
      postEvents: vi.fn().mockResolvedValue({
        accepted: 2,
        rejected: 0,
        duplicates: 0,
        errors: [],
      }),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect(outbox.depth()).toBe(0)
    expect(drainer.totalPushed).toBe(2)
    expect(drainer.lastSuccessAt).toBeDefined()
    cleanup()
  })

  it('persists max-ts as last_synced_ts after successful push (R12)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1', '2026-05-12T00:00:00.000Z'), '2026-05-12T00:00:00.000Z')
    outbox.insert(fakeEvent('run_2', '2026-05-12T00:00:09.000Z'), '2026-05-12T00:00:09.000Z')
    outbox.insert(fakeEvent('run_3', '2026-05-12T00:00:05.000Z'), '2026-05-12T00:00:05.000Z')

    const client = {
      postEvents: vi.fn().mockResolvedValue({ accepted: 3, rejected: 0, duplicates: 0, errors: [] }),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect(outbox.getLastSyncedTs()).toBe('2026-05-12T00:00:09.000Z')
    cleanup()
  })

  it('bumps retry on 5xx (TransientError)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    const client = {
      postEvents: vi.fn().mockRejectedValue(new TransientError('503')),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect(outbox.depth()).toBe(1)
    expect(drainer.total5xx).toBe(1)
    const rows = outbox.dueRows(10, { ignoreSchedule: true })
    expect(rows[0].attempts).toBe(1)
    cleanup()
  })

  it('drops rows on 4xx (PermanentError)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    const client = {
      postEvents: vi.fn().mockRejectedValue(new PermanentError('400 bad', 400)),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    let dropEvent: { count: number; status: number } | undefined
    drainer.on('drop', (e) => {
      dropEvent = e
    })
    await drainer.tick()
    expect(outbox.depth()).toBe(0)
    expect(drainer.total4xx).toBe(1)
    expect(dropEvent).toEqual({ count: 1, status: 400 })
    cleanup()
  })

  it('halts on 401 (does not delete; emits halted)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    const client = {
      postEvents: vi.fn().mockRejectedValue(new HaltedError('401')),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    let haltedReceived = false
    drainer.on('halted', () => {
      haltedReceived = true
    })
    await drainer.tick()
    expect(outbox.depth()).toBe(1)
    expect(haltedReceived).toBe(true)
    expect(drainer.halted).toBe(true)
    cleanup()
  })

  it('skips tick when halted (idempotent)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    const client = {
      postEvents: vi.fn().mockRejectedValue(new HaltedError('401')),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    await drainer.tick()
    await drainer.tick()
    expect((client.postEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    cleanup()
  })

  it('returns early when outbox is empty (no client call)', async () => {
    const { outbox, cleanup } = mkOutbox()
    const client = {
      postEvents: vi.fn().mockResolvedValue({ accepted: 0, rejected: 0, duplicates: 0, errors: [] }),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect((client.postEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    cleanup()
  })

  it('respects batchSize limit (only pushes up to N rows per tick)', async () => {
    const { outbox, cleanup } = mkOutbox()
    for (let i = 0; i < 5; i++) {
      outbox.insert(fakeEvent(`run_${i}`, `2026-05-12T00:00:0${i}.000Z`), `2026-05-12T00:00:0${i}.000Z`)
    }
    const client = {
      postEvents: vi.fn().mockResolvedValue({ accepted: 0, rejected: 0, duplicates: 0, errors: [] }),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 2 })
    await drainer.tick()
    expect((client.postEvents as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2)
    expect(outbox.depth()).toBe(3)
    cleanup()
  })

  it('treats unknown errors as transient (defensive)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    const client = {
      postEvents: vi.fn().mockRejectedValue(new Error('network unreachable')),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect(outbox.depth()).toBe(1)
    expect(drainer.total5xx).toBe(1)
    cleanup()
  })

  it('counts duplicates toward totalPushed (server-side dedup)', async () => {
    const { outbox, cleanup } = mkOutbox()
    outbox.insert(fakeEvent('run_1'), '2026-05-12T00:00:00.000Z')
    outbox.insert(fakeEvent('run_2'), '2026-05-12T00:00:01.000Z')
    const client = {
      postEvents: vi.fn().mockResolvedValue({
        accepted: 1,
        rejected: 0,
        duplicates: 1,
        errors: [],
      }),
    } as unknown as CloudClient
    const drainer = new Drainer({ outbox, client, batchSize: 100 })
    await drainer.tick()
    expect(drainer.totalPushed).toBe(2)
    expect(outbox.depth()).toBe(0)
    cleanup()
  })
})
