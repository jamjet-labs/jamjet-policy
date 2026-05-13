// Daemon orchestrator — single long-running process that wires together
// the lock, outbox, tailer, drainer, approval-poller, cap-enforcer and
// startup replay.
//
// Lifecycle:
//   1. Acquire ~/.jamjet/sync/daemon.pid (R11 — singleton).
//   2. Open SQLite outbox.
//   3. Run startup-replay to close the daemon-was-offline miss-window (R12).
//   4. Start the tailer on today's audit dir; events flow into the outbox
//      after redaction (R9).
//   5. Schedule drainer + approval-poller + cap-enforcer on their intervals.
//
// Errors from tick() are swallowed at the timer boundary — individual
// modules already encode the right per-error response (retry / drop / halt).
// A throw at this level would crash the daemon; instead we keep the loop
// alive and let `jamjet sync status` surface degraded state.
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

export class Daemon {
  private outbox?: Outbox
  private drainer?: Drainer
  private tailer?: Tailer
  private poller?: ApprovalPoller
  private cap?: CapEnforcer
  private timers: NodeJS.Timeout[] = []
  private release?: ReleaseFn
  startedAt?: string

  constructor(private readonly opts: DaemonOptions) {}

  private rootDir(): string {
    return this.opts.homeDir ?? join(homedir(), '.jamjet')
  }

  async start(): Promise<void> {
    const root = this.rootDir()
    const syncDir = join(root, 'sync')
    const auditDir = join(root, 'audit')
    const pendingDir = join(root, 'pending')
    mkdirSync(syncDir, { recursive: true })

    this.release = await acquireLock(join(syncDir, 'daemon.pid'))
    this.startedAt = new Date().toISOString()

    this.outbox = new Outbox(join(syncDir, 'outbox.db'))
    const client = new CloudClient({
      apiBase: this.opts.config.cloud.api_base,
      apiKey: this.opts.config.cloud.api_key,
      userAgent: '@jamjet/cli sync/daemon',
      pathMode: 'daemon',
    })

    // 1. Startup replay (R12). Applies args redaction inline so backlog
    // events honor the same R9 contract as live tailer writes.
    const replayed = await replayBacklog({
      outbox: this.outbox,
      auditDir,
      filter: this.opts.config.cloud.push,
      argsRedaction: this.opts.config.cloud.args_redaction,
    })
    process.stderr.write(
      `[jamjet-sync] startup-replay enqueued ${replayed} backlog events\n`,
    )

    // 2. Tailer for today.
    const today = new Date().toISOString().slice(0, 10)
    this.tailer = new Tailer({
      auditDir,
      todayDir: today,
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

    // 3. Drainer.
    this.drainer = new Drainer({
      outbox: this.outbox,
      client,
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
    this.poller = new ApprovalPoller({ pendingDir, client })
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
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    await this.tailer?.stop()
    this.outbox?.close()
    await this.release?.()
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
