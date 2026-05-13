import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../src/sync/outbox.js'
import { CapEnforcer } from '../src/sync/cap-enforcer.js'

describe('CapEnforcer', () => {
  let dir: string
  let outbox: Outbox

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jamjet-cap-test-'))
    outbox = new Outbox(join(dir, 'out.db'))
  })

  afterEach(() => {
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('no-op when under cap', () => {
    outbox.insert('{"a":1}', '2026-05-12T00:00:00Z')
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 1000,
      maxAgeDays: 7,
    })
    expect(enforcer.tick()).toBe(0)
    expect(outbox.depth()).toBe(1)
    expect(existsSync(join(dir, 'dropped.log'))).toBe(false)
  })

  it('drops oldest when over event cap', () => {
    for (let i = 0; i < 10; i++) {
      outbox.insert(`{"i":${i}}`, `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    }
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 5,
      maxAgeDays: 9999,
    })
    const dropped = enforcer.tick()
    expect(dropped).toBe(5)
    expect(outbox.depth()).toBe(5)

    const log = readFileSync(join(dir, 'dropped.log'), 'utf-8').trim().split('\n')
    expect(log.length).toBe(5)
    const first = JSON.parse(log[0])
    expect(first.event_json).toBeDefined()
    expect(first.dropped_at).toBeDefined()
    expect(first.reason).toBe('cap_breach')
  })

  it('drops events older than maxAgeDays', () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const freshTs = new Date().toISOString()
    outbox.insert('{"a":"old"}', oldTs)
    outbox.insert('{"a":"fresh"}', freshTs)
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 1000,
      maxAgeDays: 7,
    })
    const dropped = enforcer.tick()
    expect(dropped).toBe(1)
    expect(outbox.depth()).toBe(1)
  })

  it('age-dropped events get reason "age_exceeded"', () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    outbox.insert('{"a":"old"}', oldTs)
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 1000,
      maxAgeDays: 7,
    })
    enforcer.tick()
    const log = readFileSync(join(dir, 'dropped.log'), 'utf-8').trim().split('\n')
    expect(log).toHaveLength(1)
    expect(JSON.parse(log[0]).reason).toBe('age_exceeded')
  })

  it('combined cap + age dropping', () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    // 3 ancient + 5 fresh, cap=4, age=7 days → drop 3 by age, then 1 by cap (oldest of remaining)
    for (let i = 0; i < 3; i++) outbox.insert(`{"old":${i}}`, oldTs)
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.now() - i * 1000).toISOString()
      outbox.insert(`{"fresh":${i}}`, ts)
    }
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 4,
      maxAgeDays: 7,
    })
    enforcer.tick()
    expect(outbox.depth()).toBe(4)
  })

  it('totalDropped accumulates across ticks', () => {
    for (let i = 0; i < 10; i++) {
      outbox.insert(`{"i":${i}}`, `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    }
    const enforcer = new CapEnforcer({
      outbox,
      droppedLogPath: join(dir, 'dropped.log'),
      maxEvents: 5,
      maxAgeDays: 9999,
    })
    enforcer.tick()
    expect(enforcer.totalDropped).toBe(5)

    for (let i = 0; i < 3; i++) {
      outbox.insert(`{"j":${i}}`, '2026-05-13T00:00:00Z')
    }
    enforcer.tick()
    expect(enforcer.totalDropped).toBe(8)
  })

  it('creates dropped log parent directory if missing', () => {
    const nestedPath = join(dir, 'a', 'b', 'dropped.log')
    new CapEnforcer({
      outbox,
      droppedLogPath: nestedPath,
      maxEvents: 100,
      maxAgeDays: 7,
    })
    expect(existsSync(join(dir, 'a', 'b'))).toBe(true)
  })
})
