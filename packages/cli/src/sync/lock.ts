// PID-file lock for the sync daemon (R11: singleton daemon).
//
// Uses fs `wx` flag (exclusive create) — atomic at the OS level on POSIX and
// Windows. On startup, if a lock file already exists we read it and probe the
// recorded pid: if alive, reject; if dead (or the file is corrupt), reclaim.
// Reclaim handles the common case of a daemon crash that left a stale .pid.
//
// `proper-lockfile` was considered but adds a dep purely for OS-level mutex
// across hosts (NFS, etc.) — overkill for a single-user CLI daemon writing
// under $HOME on the local machine.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LockInfo {
  pid: number
  started_at: string
}

export type ReleaseFn = () => Promise<void>

export async function acquireLock(path: string): Promise<ReleaseFn> {
  mkdirSync(dirname(path), { recursive: true })

  if (existsSync(path)) {
    const info = readLock(path)
    if (info && isPidAlive(info.pid)) {
      throw new Error(
        `another daemon is already running (pid ${info.pid}). Use \`jamjet sync stop\` or \`kill ${info.pid}\` first.`,
      )
    }
    try {
      unlinkSync(path)
    } catch {
      // race-safe: another reclaimer beat us
    }
  }

  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() }
  writeFileSync(path, JSON.stringify(info), { flag: 'wx' })

  let released = false

  const cleanup = () => {
    try {
      const current = readLock(path)
      if (current?.pid === process.pid) {
        unlinkSync(path)
      }
    } catch {
      // already gone
    }
  }

  const onExit = () => cleanup()
  const onSignal = () => {
    cleanup()
    process.exit(0)
  }

  process.on('exit', onExit)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const release: ReleaseFn = async () => {
    if (released) return
    released = true
    process.off('exit', onExit)
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    cleanup()
  }

  return release
}

export function readLock(path: string): LockInfo | undefined {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.pid !== 'number' || typeof parsed?.started_at !== 'string') {
      return undefined
    }
    return parsed as LockInfo
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}
