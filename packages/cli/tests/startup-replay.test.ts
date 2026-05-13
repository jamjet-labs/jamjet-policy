import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../src/sync/outbox.js'
import { replayBacklog } from '../src/sync/startup-replay.js'

const EVT = (ts: string, run_id: string, decision: string = 'BLOCKED') =>
  JSON.stringify({
    ts,
    run_id,
    adapter: 'openai-guardrail',
    host: 'openai-agents-sdk',
    tool: 'x.y',
    decision,
    executed: false,
    schema_version: 1,
    args: {},
  })

describe('replayBacklog', () => {
  let dir: string
  let outbox: Outbox

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jamjet-replay-test-'))
    outbox = new Outbox(join(dir, 'out.db'))
  })

  afterEach(() => {
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('redacts args before insert when argsRedaction=full (R9)', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    const eventWithArgs = JSON.stringify({
      ts: '2026-05-12T00:00:00.000Z',
      run_id: 'run_secret',
      adapter: 'openai-guardrail',
      host: 'openai-agents-sdk',
      tool: 'payments.refund',
      decision: 'BLOCKED',
      executed: false,
      schema_version: 1,
      args: { customer_email: 'alice@example.com', amount: 50000 },
    })
    writeFileSync(join(auditDir, 'a.jsonl'), eventWithArgs + '\n')

    await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'all',
      argsRedaction: 'full',
    })

    const rows = outbox.dueRows(10, { ignoreSchedule: true })
    expect(rows).toHaveLength(1)
    const event = JSON.parse(rows[0].event_json)
    expect(event.args).toEqual({ redacted: true })
    expect(event.args_redaction).toBe('full')
    expect(event.args.customer_email).toBeUndefined()
  })

  it('enqueues events newer than lastSyncedTs', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      EVT('2026-05-12T00:00:00.000Z', 'run_old') +
        '\n' +
        EVT('2026-05-12T00:01:00.000Z', 'run_newone') +
        '\n' +
        EVT('2026-05-12T00:02:00.000Z', 'run_newtwo') +
        '\n',
    )
    outbox.setLastSyncedTs('2026-05-12T00:00:30.000Z')
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'interesting',
      argsRedaction: 'full',
    })
    expect(count).toBe(2)
    expect(outbox.depth()).toBe(2)
  })

  it('enqueues everything when no lastSyncedTs', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      EVT('2026-05-12T00:00:00.000Z', 'run_a', 'BLOCKED') +
        '\n' +
        EVT('2026-05-12T00:01:00.000Z', 'run_b', 'AUDIT') +
        '\n',
    )
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'interesting',
      argsRedaction: 'full',
    })
    expect(count).toBe(2)
  })

  it('respects interesting-only filter', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      EVT('2026-05-12T00:00:00.000Z', 'run_a', 'ALLOWED') +
        '\n' +
        EVT('2026-05-12T00:01:00.000Z', 'run_b', 'BLOCKED') +
        '\n',
    )
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'interesting',
      argsRedaction: 'full',
    })
    expect(count).toBe(1)
  })

  it('walks multiple date directories in order', async () => {
    mkdirSync(join(dir, 'audit', '2026-05-10'), { recursive: true })
    mkdirSync(join(dir, 'audit', '2026-05-11'), { recursive: true })
    mkdirSync(join(dir, 'audit', '2026-05-12'), { recursive: true })
    writeFileSync(
      join(dir, 'audit', '2026-05-10', 'x.jsonl'),
      EVT('2026-05-10T00:00:00.000Z', 'run_a') + '\n',
    )
    writeFileSync(
      join(dir, 'audit', '2026-05-11', 'x.jsonl'),
      EVT('2026-05-11T00:00:00.000Z', 'run_b') + '\n',
    )
    writeFileSync(
      join(dir, 'audit', '2026-05-12', 'x.jsonl'),
      EVT('2026-05-12T00:00:00.000Z', 'run_c') + '\n',
    )
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'all',
      argsRedaction: 'full',
    })
    expect(count).toBe(3)
  })

  it('returns 0 when auditDir does not exist', async () => {
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'missing'),
      filter: 'all',
      argsRedaction: 'full',
    })
    expect(count).toBe(0)
  })

  it('returns 0 when auditDir has no date subdirs', async () => {
    mkdirSync(join(dir, 'audit'), { recursive: true })
    writeFileSync(
      join(dir, 'audit', 'not-a-date'),
      EVT('2026-05-12T00:00:00.000Z', 'run_a') + '\n',
    )
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'all',
      argsRedaction: 'full',
    })
    expect(count).toBe(0)
  })

  it('skips malformed lines and schema-invalid events', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      '{not valid json\n' +
        JSON.stringify({ ts: 'bad', run_id: 'no_prefix' }) +
        '\n' +
        EVT('2026-05-12T00:01:00.000Z', 'run_ok', 'BLOCKED') +
        '\n',
    )
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'all',
      argsRedaction: 'full',
    })
    expect(count).toBe(1)
  })

  it('lastSyncedTs comparison uses strict > (matching ts is treated as already synced)', async () => {
    const auditDir = join(dir, 'audit', '2026-05-12')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'a.jsonl'),
      EVT('2026-05-12T00:00:00.000Z', 'run_exact') + '\n',
    )
    outbox.setLastSyncedTs('2026-05-12T00:00:00.000Z')
    const count = await replayBacklog({
      outbox,
      auditDir: join(dir, 'audit'),
      filter: 'all',
      argsRedaction: 'full',
    })
    expect(count).toBe(0)
  })
})
