import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, readLock } from '../src/sync/lock.js'

describe('PID lock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jamjet-lock-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('acquires lock when none exists', async () => {
    const release = await acquireLock(join(dir, 'd.pid'))
    expect(typeof release).toBe('function')
    await release()
  })

  it('creates parent directory if missing', async () => {
    const release = await acquireLock(join(dir, 'nested', 'sub', 'd.pid'))
    await release()
  })

  it('rejects second acquire while first is held', async () => {
    const release = await acquireLock(join(dir, 'd.pid'))
    await expect(acquireLock(join(dir, 'd.pid'))).rejects.toThrow(/another daemon/i)
    await release()
  })

  it('lets a new acquire succeed after release', async () => {
    const r1 = await acquireLock(join(dir, 'd.pid'))
    await r1()
    const r2 = await acquireLock(join(dir, 'd.pid'))
    await r2()
  })

  it('readLock returns the holding pid', async () => {
    const release = await acquireLock(join(dir, 'd.pid'))
    const info = readLock(join(dir, 'd.pid'))
    expect(info?.pid).toBe(process.pid)
    expect(info?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await release()
  })

  it('readLock returns undefined when no lock file exists', () => {
    const info = readLock(join(dir, 'missing.pid'))
    expect(info).toBeUndefined()
  })

  it('reclaims stale lock when prior pid is dead', async () => {
    // pid 1 is init/launchd on Unix — we cannot signal it, so it always
    // looks alive. Pick a pid that definitely doesn't exist: 0x7FFFFFFF.
    const deadPid = 0x7fffffff
    writeFileSync(
      join(dir, 'd.pid'),
      JSON.stringify({ pid: deadPid, started_at: new Date().toISOString() }),
    )
    const release = await acquireLock(join(dir, 'd.pid'))
    const info = readLock(join(dir, 'd.pid'))
    expect(info?.pid).toBe(process.pid)
    await release()
  })

  it('reclaims lock with corrupted JSON', async () => {
    writeFileSync(join(dir, 'd.pid'), 'not valid json{')
    const release = await acquireLock(join(dir, 'd.pid'))
    const info = readLock(join(dir, 'd.pid'))
    expect(info?.pid).toBe(process.pid)
    await release()
  })

  it('release is idempotent', async () => {
    const release = await acquireLock(join(dir, 'd.pid'))
    await release()
    await release() // must not throw
    await release()
  })
})
