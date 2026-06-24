import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
}

export function actionHash(action: AuthzAction): string {
  return sha256Canonical({ server: action.server, tool: action.tool, args: action.args })
}

export function createHoldStore(dir: string): HoldStore {
  mkdirSync(dir, { recursive: true })
  const recPath = (runId: string) => join(dir, `${runId}.json`)
  const read = (runId: string): HoldRecord | null =>
    existsSync(recPath(runId)) ? (JSON.parse(readFileSync(recPath(runId), 'utf-8')) as HoldRecord) : null
  return {
    hold(action, now) {
      const h = actionHash(action)
      const runId = `run_${h.slice(7, 19)}` // strip "sha256:" prefix; deterministic per action
      const existing = read(runId)
      if (existing) return existing
      const rec: HoldRecord = { run_id: runId, action_hash: h, tool: action.tool, created_at: now, status: 'pending' }
      writeFileSync(recPath(runId), JSON.stringify(rec), 'utf-8')
      return rec
    },
    find(action) {
      return read(`run_${actionHash(action).slice(7, 19)}`)
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
  }
}
