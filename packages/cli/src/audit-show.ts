import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface AuditEvent {
  ts: string
  run_id: string
  adapter: string
  host: string
  tool: string
  decision: string
  rule: string | null
  executed: boolean
  schema_version: number
}

export interface AuditShowOptions {
  /** YYYY-MM-DD; defaults to today (UTC). */
  date?: string
  adapter?: string
  /** Override the base audit directory. Defaults to `~/.jamjet/audit`. */
  baseDir?: string
}

export function auditShow(opts: AuditShowOptions = {}): void {
  const baseDir = opts.baseDir ?? join(homedir(), '.jamjet', 'audit')
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  const dayDir = join(baseDir, date)
  if (!existsSync(dayDir)) {
    process.stdout.write(`(no events for ${date})\n`)
    return
  }

  const files = readdirSync(dayDir).filter((f) => f.endsWith('.jsonl'))
  const events: AuditEvent[] = []
  for (const f of files) {
    if (opts.adapter && !f.startsWith(opts.adapter)) continue
    for (const line of readFileSync(join(dayDir, f), 'utf-8').trim().split('\n')) {
      if (!line) continue
      try {
        events.push(JSON.parse(line) as AuditEvent)
      } catch {
        // Skip malformed lines (rare; usually mid-write truncation).
      }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts))

  for (const e of events) {
    const marker =
      e.decision === 'BLOCKED' ? '✗'
      : e.decision === 'WAITING_FOR_APPROVAL' ? '⏸'
      : e.decision === 'AUDIT' ? 'ℹ'
      : '✓'
    process.stdout.write(
      `${marker} ${e.ts}  ${e.adapter.padEnd(20)} ${e.tool.padEnd(40)} ${e.decision}  ${e.rule ?? ''}\n`,
    )
  }
}
