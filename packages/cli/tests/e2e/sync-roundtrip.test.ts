// E2E roundtrip test against a real Cloud deployment.
//
// Skipped by default. To run:
//
//   1. `jamjet cloud link` against your test/preview project to get an api_key.
//   2. Export env vars:
//        JAMJET_E2E_API_BASE=https://api.jamjet.dev
//        JAMJET_E2E_API_KEY=jj_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//        JAMJET_E2E_PROJECT_ID=<uuid>
//   3. `pnpm test -- sync-roundtrip`
//
// The test writes a fresh audit event to a temp ~/.jamjet/audit/<date>/ dir,
// starts the daemon, and waits up to 10s for the snapshot's events_pushed_total
// to advance. Because event run_ids are uniquely generated per run, retries
// are safe — Cloud's (project_id, run_id, ts, decision) dedup just records
// duplicates without rejecting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../../src/sync/daemon.js'
import type { Config } from '../../src/types.js'

const PREVIEW_URL = process.env.JAMJET_E2E_API_BASE
const PREVIEW_KEY = process.env.JAMJET_E2E_API_KEY
const PREVIEW_PROJECT = process.env.JAMJET_E2E_PROJECT_ID

const haveEnv = !!(PREVIEW_URL && PREVIEW_KEY && PREVIEW_PROJECT)
const describeOrSkip = haveEnv ? describe : describe.skip

describeOrSkip('sync roundtrip (e2e against deployed Cloud)', () => {
  let tmpHome: string

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'jamjet-e2e-'))
    const today = new Date().toISOString().slice(0, 10)
    mkdirSync(join(tmpHome, 'audit', today), { recursive: true })
    mkdirSync(join(tmpHome, 'pending'), { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes a BLOCKED event locally → daemon pushes → Cloud accepts (no 4xx/5xx)', async () => {
    const cfg: Config = {
      cloud: {
        project_id: PREVIEW_PROJECT!,
        api_key: PREVIEW_KEY!,
        api_base: PREVIEW_URL!,
        args_redaction: 'full',
        push: 'interesting',
        poll_interval_seconds: 5,
        drainer_interval_seconds: 1,
        metrics_port: 9876,
        metrics_enabled: false,
        outbox_max_events: 100_000,
        outbox_max_age_days: 7,
      },
    }
    const daemon = new Daemon({ config: cfg, homeDir: tmpHome })
    await daemon.start()

    const today = new Date().toISOString().slice(0, 10)
    const runId = `run_e2e${Date.now().toString(36)}`
    const event = {
      ts: new Date().toISOString(),
      run_id: runId,
      adapter: 'openai-guardrail',
      host: 'openai-agents-sdk',
      tool: 'e2e.test',
      decision: 'BLOCKED',
      rule: '*.delete',
      rule_kind: 'block',
      executed: false,
      schema_version: 1,
      args: { reason: 'e2e_smoke' },
    }
    writeFileSync(
      join(tmpHome, 'audit', today, 'openai-guardrail-e2e.jsonl'),
      JSON.stringify(event) + '\n',
    )

    let pushed = false
    let snap = daemon.snapshot()
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      snap = daemon.snapshot()
      if (snap.events_pushed_total > 0) {
        pushed = true
        break
      }
    }

    await daemon.stop()

    expect(pushed, `expected events_pushed_total > 0 within 10s; final snap=${JSON.stringify(snap)}`).toBe(true)
    expect(snap.http_4xx_total, '4xx errors during e2e push').toBe(0)
    expect(snap.state).not.toBe('unauthorized')
    expect(snap.outbox_depth, 'outbox should be empty after successful push').toBe(0)
  }, 30_000)
})
