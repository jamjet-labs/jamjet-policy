import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Canonical } from '@jamjet/mcp-threat'
import type { AuthzAction } from './types.js'

export type HoldStatus = 'pending' | 'approved' | 'rejected' | 'unknown'

export interface HoldRecord {
  run_id: string
  action_hash: string
  tool: string
  created_at: string
  status: Exclude<HoldStatus, 'unknown'>
}

export interface HoldStore {
  hold(action: AuthzAction, now: string): HoldRecord
  find(action: AuthzAction): HoldRecord | null
  peek(runId: string): HoldStatus
  resolve(runId: string, status: 'approved' | 'rejected'): boolean
  consume(runId: string): boolean
}

// runIds are `run_` + 32 lowercase hex chars (a 128-bit slice of the action hash).
// Validate before any filesystem access so an operator- or client-supplied id
// cannot escape the hold directory via path traversal (e.g. "../../etc/x").
const RUN_ID_RE = /^run_[0-9a-f]{32}$/

export function actionHash(action: AuthzAction): string {
  return sha256Canonical({ server: action.server, tool: action.tool, args: action.args })
}

function runIdFor(action: AuthzAction): string {
  return `run_${actionHash(action).slice(7, 39)}` // strip "sha256:" prefix; 128-bit width
}

export function createHoldStore(dir: string): HoldStore {
  mkdirSync(dir, { recursive: true })
  const recPath = (runId: string) => join(dir, `${runId}.json`)
  const read = (runId: string): HoldRecord | null => {
    if (!RUN_ID_RE.test(runId)) return null
    return existsSync(recPath(runId)) ? (JSON.parse(readFileSync(recPath(runId), 'utf-8')) as HoldRecord) : null
  }
  return {
    hold(action, now) {
      const runId = runIdFor(action)
      const existing = read(runId)
      if (existing) return existing
      const rec: HoldRecord = { run_id: runId, action_hash: actionHash(action), tool: action.tool, created_at: now, status: 'pending' }
      writeFileSync(recPath(runId), JSON.stringify(rec), 'utf-8')
      return rec
    },
    find(action) {
      return read(runIdFor(action))
    },
    peek(runId) {
      return read(runId)?.status ?? 'unknown'
    },
    resolve(runId, status) {
      const rec = read(runId)
      if (!rec) return false
      rec.status = status
      writeFileSync(recPath(runId), JSON.stringify(rec), 'utf-8')
      return true
    },
    consume(runId) {
      if (!RUN_ID_RE.test(runId) || !existsSync(recPath(runId))) return false
      rmSync(recPath(runId))
      return true
    },
  }
}
