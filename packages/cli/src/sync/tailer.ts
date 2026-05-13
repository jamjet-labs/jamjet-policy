// Tailer — watches today's audit directory for new JSONL lines and emits
// parsed AuditEventV1 events. Filters by decision when configured.
//
// Position tracking: per-file byte offset stored in-memory. On each fs event
// we read from the last offset to the current file size (statSync as ground
// truth — avoids drift from miscounting newlines). chokidar 'change' may fire
// while we're still reading; per-file in-flight guard ensures we re-run once
// after the in-progress read completes rather than racing.
//
// Daily rollover: the orchestrator (Task 13) is responsible for stopping the
// tailer at midnight UTC and starting a fresh one on the new date.
import { EventEmitter } from 'node:events'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import chokidar, { type FSWatcher } from 'chokidar'
import { AuditEventV1Schema, INTERESTING_DECISIONS, type AuditEventV1 } from '../types.js'

export interface TailerOptions {
  auditDir: string
  todayDir: string
  filter: 'all' | 'interesting'
}

export interface TailerEvents {
  event: (e: AuditEventV1) => void
}

export class Tailer extends EventEmitter {
  private watcher?: FSWatcher
  private filePositions = new Map<string, number>()
  private inFlight = new Map<string, boolean>()
  private dirty = new Map<string, boolean>()
  private stopped = false
  parseErrors = 0

  constructor(private readonly opts: TailerOptions) {
    super()
  }

  async start(): Promise<void> {
    const watchDir = join(this.opts.auditDir, this.opts.todayDir)
    this.watcher = chokidar.watch(watchDir, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      usePolling: false,
    })
    this.watcher.on('add', (path) => {
      void this.handleFile(path)
    })
    this.watcher.on('change', (path) => {
      void this.handleFile(path)
    })

    // Wait for chokidar to finish initial scan so 'ready' fires before tests
    // resolve start(). Without this, backlog files may not have been read yet
    // when the caller's `await tailer.start()` returns.
    await new Promise<void>((resolve) => {
      this.watcher!.once('ready', () => resolve())
    })
  }

  private async handleFile(path: string): Promise<void> {
    if (this.stopped) return
    if (!path.endsWith('.jsonl')) return

    if (this.inFlight.get(path)) {
      this.dirty.set(path, true)
      return
    }
    this.inFlight.set(path, true)
    try {
      await this.readSince(path)
    } finally {
      this.inFlight.set(path, false)
      if (this.dirty.get(path)) {
        this.dirty.set(path, false)
        void this.handleFile(path)
      }
    }
  }

  private async readSince(path: string): Promise<void> {
    const lastPos = this.filePositions.get(path) ?? 0
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size <= lastPos) return

    // Bound the read explicitly so writes that land after we snapshot size
    // are deferred to the next watcher event (which will fire on 'change').
    const stream = createReadStream(path, { start: lastPos, end: size - 1 })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (this.stopped) break
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        this.parseErrors++
        continue
      }
      const parsed = AuditEventV1Schema.safeParse(raw)
      if (!parsed.success) {
        this.parseErrors++
        continue
      }
      const event = parsed.data
      if (
        this.opts.filter === 'interesting' &&
        !INTERESTING_DECISIONS.includes(event.decision)
      ) {
        continue
      }
      this.emit('event', event)
    }
    this.filePositions.set(path, size)
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.watcher?.close()
    this.watcher = undefined
  }
}
