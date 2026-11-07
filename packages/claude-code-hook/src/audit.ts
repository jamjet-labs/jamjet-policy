// Local audit log for the hook.
//
// The hook's decision only reaches Claude Code when the process exits, so the
// audit write must never be able to hold that up. A FIFO, a symlink or a
// stalled mount at the audit path would otherwise keep the hook running until
// Claude Code's timeout, and a timed-out hook lets the tool run.
//
// A deadline inside the hook's own process is not enough: Node joins its
// libuv threadpool on exit, so a thread stuck in open() or write() keeps
// process.exit() from returning. The write therefore happens in a child
// process (dist/audit-writer.js). The hook waits up to AUDIT_DEADLINE_MS,
// then kills the child and exits; exiting never waits for a child.
//
// In the child, the file is opened O_NONBLOCK (a FIFO with no reader fails at
// once) and O_NOFOLLOW (a symlinked log file fails), must fstat as a regular
// file, and new directories are 0700 and new files 0600.

import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const AUDIT_DEADLINE_MS = 2000
export const AUDIT_FILE = 'claude-code-hook.jsonl'

const OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NONBLOCK ?? 0) |
  (constants.O_NOFOLLOW ?? 0)

export interface AuditWrite {
  dir: string
  rotateDaily: boolean
  ts: string
  line: string
}

/** The actual write. Runs in the child process. */
export function appendAuditLineSync(w: AuditWrite): void {
  const dayDir = join(w.dir, w.rotateDaily ? w.ts.slice(0, 10) : 'all')
  mkdirSync(dayDir, { recursive: true, mode: 0o700 })
  const file = join(dayDir, AUDIT_FILE)
  const fd = openSync(file, OPEN_FLAGS, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`)
    const buf = Buffer.from(w.line, 'utf-8')
    let offset = 0
    while (offset < buf.length) offset += writeSync(fd, buf, offset)
  } finally {
    closeSync(fd)
  }
}

/**
 * Run `writerPath` (dist/audit-writer.js) with the write on stdin. Resolves
 * when it exits 0. Rejects on any other exit, on a spawn error, or after
 * `deadlineMs`, in which case the child is killed and left behind.
 */
export function writeAuditInChild(writerPath: string, w: AuditWrite, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const child = spawn(process.execPath, [writerPath], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 2000) stderr += d
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(new Error(`audit write did not finish within ${deadlineMs} ms`))
    }, deadlineMs)
    child.on('error', (err) => settle(err))
    child.on('exit', (code, signal) => {
      if (code === 0) settle()
      else settle(new Error(stderr.trim() || `audit writer exited with ${code ?? signal}`))
    })
    child.stdin.on('error', () => {
      // The child exiting early closes the pipe; its exit status reports why.
    })
    child.stdin.end(JSON.stringify(w))
  })
}
