import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Canonical } from '@jamjet/mcp-threat'
import type { AgentPrincipal } from '@jamjet/cedar'
import type { AuthzAction } from './types.js'

export type HoldStatus = 'pending' | 'approved' | 'rejected' | 'unknown'

export interface HoldRecord {
  run_id: string
  action_hash: string
  tool: string
  created_at: string
  status: Exclude<HoldStatus, 'unknown'>
  /** Who asked, so the approver can see it. Present when the PEP named a principal. */
  principal?: AgentPrincipal
  risk?: string
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

// When the enforcement point names the caller, the hold is bound to it: an approval
// granted to one principal cannot release the same call for another. Without a
// principal the hash is unchanged, so existing holds stay valid.
// The hold also binds the rest of the evaluated context (subject kind, claims, risk):
// an approval granted for one context must not be spent in another.
export function actionHash(action: AuthzAction): string {
  const base: Record<string, unknown> = { server: action.server, tool: action.tool, args: action.args }
  if (action.principal) {
    base.principal = {
      id: action.principal.id,
      kind: action.principal.kind ?? null,
      run_id: action.principal.runId ?? null,
      tags: action.principal.tags ?? {},
    }
  }
  if (action.risk !== undefined) base.risk = action.risk
  return sha256Canonical(base)
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
      const rec: HoldRecord = {
        run_id: runId,
        action_hash: actionHash(action),
        tool: action.tool,
        created_at: now,
        status: 'pending',
        ...(action.principal ? { principal: action.principal } : {}),
        ...(action.risk !== undefined ? { risk: action.risk } : {}),
      }
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
      if (!RUN_ID_RE.test(runId)) return false
      // One unlink, no exists-then-remove window: of two requests (or replicas sharing
      // the directory) consuming the same approval, exactly one gets true.
      try {
        unlinkSync(recPath(runId))
        return true
      } catch {
        return false
      }
    },
  }
}
