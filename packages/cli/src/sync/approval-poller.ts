// Approval poller — every N seconds, query Cloud for decisions on the
// run_ids that are currently pending locally, then write the marker file
// the adapter is waiting for.
//
// Marker contract matches Phase 2's local `jamjet approve/reject` (see
// approve.ts): `~/.jamjet/pending/resolved/<run_id>.approved` (or .rejected)
// containing the original pending payload merged with decision metadata.
// We add `source: 'cloud'` so consumers can tell local vs Cloud decisions
// apart in audit trails.
//
// Atomicity: write to a `.tmp` then renameSync onto the final marker path,
// then unlink the pending file. A crash between rename and unlink leaves a
// marker file with the pending file still present — adapters look at the
// marker first, so the outcome is still correct; a later tick will see the
// pending file is gone (after resolved) and stop polling that run_id.
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type CloudClient, HaltedError } from '../cloud/http.js'

export interface ApprovalPollerOptions {
  pendingDir: string
  client: CloudClient
}

export class ApprovalPoller extends EventEmitter {
  totalRoundTripped = 0
  halted = false

  constructor(private readonly opts: ApprovalPollerOptions) {
    super()
  }

  clearHalt(): void {
    this.halted = false
  }

  async tick(): Promise<void> {
    if (this.halted) return

    const dir = this.opts.pendingDir
    if (!existsSync(dir)) return

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    if (files.length === 0) return

    const runIds = files.map((f) => f.replace(/\.json$/, ''))

    let decisions
    try {
      decisions = await this.opts.client.approvalsPending(runIds)
    } catch (e) {
      if (e instanceof HaltedError) {
        this.halted = true
        this.emit('halted')
        return
      }
      // Transient errors silently retry on next tick.
      return
    }

    for (const decision of decisions) {
      const pendingPath = join(dir, `${decision.run_id}.json`)
      if (!existsSync(pendingPath)) continue
      let pendingData: Record<string, unknown>
      try {
        pendingData = JSON.parse(readFileSync(pendingPath, 'utf-8'))
      } catch {
        continue
      }

      if (typeof decision.status !== 'string') continue
      const status = decision.status.toLowerCase()
      if (status !== 'approved' && status !== 'rejected') continue

      const resolvedDir = join(dir, 'resolved')
      mkdirSync(resolvedDir, { recursive: true })
      const markerPath = join(resolvedDir, `${decision.run_id}.${status}`)

      const tmpPath = `${markerPath}.${process.pid}.tmp`
      writeFileSync(
        tmpPath,
        JSON.stringify(
          {
            ...pendingData,
            status,
            decided_at: decision.decided_at,
            decided_by: decision.decided_by,
            source: 'cloud',
          },
          null,
          2,
        ),
      )
      renameSync(tmpPath, markerPath)

      try {
        unlinkSync(pendingPath)
      } catch {
        // already gone
      }
      this.totalRoundTripped++
      this.emit('resolved', { run_id: decision.run_id, status })
    }
  }
}
