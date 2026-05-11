import { describe, it, expect } from 'vitest'
import { approveRunId } from '../src/approve.js'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('approveRunId', () => {
  it('moves the pending file to resolved/<run-id>.approved', () => {
    const base = mkdtempSync(join(tmpdir(), 'japprove-'))
    mkdirSync(base, { recursive: true })
    const runId = 'run_test1'
    writeFileSync(
      join(base, `${runId}.json`),
      JSON.stringify({ run_id: runId, tool: 'payments.refund' }),
    )

    const ok = approveRunId({ runId, pendingDir: base, action: 'approve' })
    expect(ok).toBe(true)
    expect(existsSync(join(base, `${runId}.json`))).toBe(false)
    expect(existsSync(join(base, 'resolved', `${runId}.approved`))).toBe(true)
    const marker = JSON.parse(readFileSync(join(base, 'resolved', `${runId}.approved`), 'utf-8'))
    expect(marker.status).toBe('approved')
    expect(marker.tool).toBe('payments.refund')
  })

  it('moves the pending file to resolved/<run-id>.rejected on reject', () => {
    const base = mkdtempSync(join(tmpdir(), 'japprove-'))
    mkdirSync(base, { recursive: true })
    const runId = 'run_test2'
    writeFileSync(
      join(base, `${runId}.json`),
      JSON.stringify({ run_id: runId, tool: 'payments.refund' }),
    )

    const ok = approveRunId({ runId, pendingDir: base, action: 'reject' })
    expect(ok).toBe(true)
    expect(existsSync(join(base, 'resolved', `${runId}.rejected`))).toBe(true)
  })

  it('returns false when run id does not exist', () => {
    const base = mkdtempSync(join(tmpdir(), 'japprove-'))
    expect(approveRunId({ runId: 'run_missing', pendingDir: base, action: 'approve' })).toBe(false)
  })
})
