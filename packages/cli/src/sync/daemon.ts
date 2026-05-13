// Daemon orchestrator — single long-running process that wires together
// the lock, outbox, tailer, drainer, approval-poller, cap-enforcer and
// startup replay.
//
// Lifecycle:
//   1. Acquire ~/.jamjet/sync/daemon.pid (R11 — singleton).
//   2. Open SQLite outbox.
//   3. Run startup-replay to close the daemon-was-offline miss-window (R12).
//   4. Start the tailer on today's audit dir; events flow into the outbox
//      after redaction (R9). A midnight-UTC timer rotates the tailer so
//      long-lived daemons don't miss new-day events.
//   5. Schedule drainer + approval-poller + cap-enforcer on their intervals.
//
// Errors from tick() are swallowed at the timer boundary — individual
// modules already encode the right per-error response (retry / drop / halt).
// A throw at this level would crash the daemon; instead we keep the loop
// alive and let `jamjet sync status` surface degraded state.
//
// If start() throws partway, the constructor rolls back the partially
// initialized resources (PID lock, open DB, watcher) so a subsequent restart
// doesn't trip over its own stale lock.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { acquireLock, type ReleaseFn } from './lock.js'
import { Outbox } from './outbox.js'
import { Tailer } from './tailer.js'
import { Drainer } from './drainer.js'
import { ApprovalPoller } from './approval-poller.js'
import { CapEnforcer } from './cap-enforcer.js'
import { replayBacklog } from './startup-replay.js'
import { applyRedaction } from './redaction.js'
import { CloudClient } from '../cloud/http.js'
import type { Config, AuditEventV1, SyncStatus } from '../types.js'

const CAP_TICK_MS = 60_000
const DRAINER_BATCH_SIZE = 100

export interface DaemonOptions {
  config: Config
  /** Override ~/.jamjet root for testing. */
  homeDir?: string
}

function todayUtcDir(): string {
  return new Date().toISOString().slice(0, 10)
}

function msUntilNextUtcMidnight(): number {
  const now = new Date()
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      5, // +5s safety so we definitely land on the new date string
    ),
  )
  return next.getTime() - now.getTime()
}

export class Daemon {
  private outbox?: Outbox
  private drainer?: Drainer
  private tailer?: Tailer
  private poller?: ApprovalPoller
  private cap?: CapEnforcer
  private client?: CloudClient
  private auditDir = ''
  private timers: NodeJS.Timeout[] = []
  private rolloverTimer?: NodeJS.Timeout
  private release?: ReleaseFn
  startedAt?: string

  constructor(private readonly opts: DaemonOptions) {}

  private rootDir(): string {
    return this.opts.homeDir ?? join(homedir(), '.jamjet')
  }

  async start(): Promise<void> {
    const root = this.rootDir()
    const syncDir = join(root, 'sync')
    this.auditDir = join(root, 'audit')
    const pendingDir = join(root, 'pending')
    mkdirSync(syncDir, { recursive: true })

    this.release = await acquireLock(join(syncDir, 'daemon.pid'))

    // From here on, any throw must roll back the lock + any open resources.
    try {
      this.startedAt = new Date().toISOString()

      this.outbox = new Outbox(join(syncDir, 'outbox.db'))
      this.client = new CloudClient({
        apiBase: this.opts.config.cloud.api_base,
        apiKey: this.opts.config.cloud.api_key,
        userAgent: '@jamjet/cli sync/daemon',
        pathMode: 'daemon',
      })

      // 1. Startup replay (R12). Applies args redaction inline so backlog
      // events honor the same R9 contract as live tailer writes.
      const replayed = await replayBacklog({
        outbox: this.outbox,
        auditDir: this.auditDir,
        filter: this.opts.config.cloud.push,
        argsRedaction: this.opts.config.cloud.args_redaction,
      })
      process.stderr.write(
        `[jamjet-sync] startup-replay enqueued ${replayed} backlog events\n`,
      )

      // 2. Tailer for today + midnight-UTC rotation.
      await this.startTailer()
      this.scheduleNextRollover()

      // 3. Drainer.
      this.drainer = new Drainer({
        outbox: this.outbox,
        client: this.client,
        batchSize: DRAINER_BATCH_SIZE,
      })
      this.drainer.on('halted', () => {
        process.stderr.write(
          `[jamjet-sync] halted on 401 — run \`jamjet cloud link\` to recover\n`,
        )
      })
      this.drainer.on('drop', (info: { count: number; status: number }) => {
        process.stderr.write(
          `[jamjet-sync] dropped ${info.count} events (HTTP ${info.status})\n`,
        )
      })
      this.timers.push(
        setInterval(
          () => void this.drainer!.tick().catch(() => {}),
          this.opts.config.cloud.drainer_interval_seconds * 1000,
        ),
      )

      // 4. Approval poller.
      this.poller = new ApprovalPoller({ pendingDir, client: this.client })
      this.poller.on('halted', () => {
        process.stderr.write(
          `[jamjet-sync] approval poller halted on 401 — run \`jamjet cloud link\`\n`,
        )
      })
      this.timers.push(
        setInterval(
          () => void this.poller!.tick().catch(() => {}),
          this.opts.config.cloud.poll_interval_seconds * 1000,
        ),
      )

      // 5. Cap enforcer — every 60s.
      this.cap = new CapEnforcer({
        outbox: this.outbox,
        droppedLogPath: join(syncDir, 'dropped.log'),
        maxEvents: this.opts.config.cloud.outbox_max_events,
        maxAgeDays: this.opts.config.cloud.outbox_max_age_days,
      })
      this.timers.push(
        setInterval(() => {
          try {
            this.cap!.tick()
          } catch {
            // swallowed — keep the daemon alive
          }
        }, CAP_TICK_MS),
      )
    } catch (err) {
      // Roll back partial init so the next start() doesn't trip on a stale lock.
      await this.teardown()
      throw err
    }
  }

  private async startTailer(): Promise<void> {
    this.tailer = new Tailer({
      auditDir: this.auditDir,
      todayDir: todayUtcDir(),
      filter: this.opts.config.cloud.push,
    })
    this.tailer.on('event', (event: AuditEventV1) => {
      const redacted = applyRedaction(event, this.opts.config.cloud.args_redaction)
      try {
        this.outbox!.insert(JSON.stringify(redacted), redacted.ts)
      } catch (e) {
        process.stderr.write(
          `[jamjet-sync] outbox insert failed: ${(e as Error).message}\n`,
        )
      }
    })
    await this.tailer.start()
  }

  private scheduleNextRollover(): void {
    this.rolloverTimer = setTimeout(() => {
      void this.rotateForNewDay().finally(() => this.scheduleNextRollover())
    }, msUntilNextUtcMidnight())
    // Don't keep the event loop alive solely for the rollover timer.
    this.rolloverTimer.unref?.()
  }

  private async rotateForNewDay(): Promise<void> {
    process.stderr.write(`[jamjet-sync] rotating tailer for new UTC day\n`)
    try {
      await this.tailer?.stop()
      await this.startTailer()
    } catch (e) {
      process.stderr.write(
        `[jamjet-sync] day rollover failed: ${(e as Error).message}\n`,
      )
    }
  }

  private async teardown(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.rolloverTimer) {
      clearTimeout(this.rolloverTimer)
      this.rolloverTimer = undefined
    }
    try {
      await this.tailer?.stop()
    } catch {
      // best-effort
    }
    this.tailer = undefined
    try {
      this.outbox?.close()
    } catch {
      // best-effort
    }
    this.outbox = undefined
    this.drainer = undefined
    this.poller = undefined
    this.cap = undefined
    this.client = undefined
    try {
      await this.release?.()
    } catch {
      // best-effort
    }
    this.release = undefined
    this.startedAt = undefined
  }

  async stop(): Promise<void> {
    await this.teardown()
  }

  snapshot(): SyncStatus {
    const halted = this.drainer?.halted ?? false
    const state: SyncStatus['state'] = !this.startedAt
      ? 'not_running'
      : halted
        ? 'unauthorized'
        : (this.outbox?.depth() ?? 0) > 1000
          ? 'degraded'
          : 'ok'
    return {
      state,
      project_id: this.opts.config.cloud.project_id,
      daemon_pid: process.pid,
      daemon_started_at: this.startedAt,
      outbox_depth: this.outbox?.depth() ?? 0,
      outbox_oldest_ts: this.outbox?.oldestTs(),
      last_successful_push_at: this.drainer?.lastSuccessAt,
      parse_errors_total: this.tailer?.parseErrors ?? 0,
      http_4xx_total: this.drainer?.total4xx ?? 0,
      http_5xx_total: this.drainer?.total5xx ?? 0,
      events_pushed_total: this.drainer?.totalPushed ?? 0,
      events_dropped_total: this.cap?.totalDropped ?? 0,
      approvals_round_tripped_total: this.poller?.totalRoundTripped ?? 0,
    }
  }
}
