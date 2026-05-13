import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tailer } from '../src/sync/tailer.js'
import type { AuditEventV1 } from '../src/types.js'

const VALID = (run_id = 'run_a', decision = 'BLOCKED', tool = 'x.y') =>
  JSON.stringify({
    ts: '2026-05-12T00:00:00.000Z',
    run_id,
    adapter: 'openai-guardrail',
    host: 'openai-agents-sdk',
    tool,
    decision,
    executed: false,
    schema_version: 1,
    args: { foo: 'bar' },
  })

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))

describe('Tailer', () => {
  let auditDir: string
  const today = '2026-05-12'

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'jamjet-tailer-test-'))
    mkdirSync(join(auditDir, today), { recursive: true })
  })

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true })
  })

  it('emits events for new JSONL lines', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'interesting' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(
      join(auditDir, today, 'openai-guardrail-pid1.jsonl'),
      VALID('run_x', 'BLOCKED') + '\n',
    )
    await wait()
    expect(events).toHaveLength(1)
    expect(events[0].run_id).toBe('run_x')
    await tailer.stop()
  })

  it('drops ALLOWED events when filter=interesting', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'interesting' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(
      join(auditDir, today, 'x.jsonl'),
      VALID('run_a', 'ALLOWED') + '\n' + VALID('run_b', 'BLOCKED') + '\n',
    )
    await wait()
    expect(events.map((e) => e.run_id)).toEqual(['run_b'])
    await tailer.stop()
  })

  it('emits all events when filter=all', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(
      join(auditDir, today, 'x.jsonl'),
      VALID('run_a', 'ALLOWED') + '\n' + VALID('run_b', 'BLOCKED') + '\n',
    )
    await wait()
    expect(events).toHaveLength(2)
    await tailer.stop()
  })

  it('skips malformed lines and increments parse_errors', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(
      join(auditDir, today, 'x.jsonl'),
      '{not valid json\n' + VALID('run_ok', 'BLOCKED') + '\n',
    )
    await wait()
    expect(events).toHaveLength(1)
    expect(tailer.parseErrors).toBe(1)
    await tailer.stop()
  })

  it('skips lines that fail schema validation', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    // missing required `decision`
    const missing = JSON.stringify({
      ts: '2026-05-12T00:00:00.000Z',
      run_id: 'run_x',
      adapter: 'openai-guardrail',
      host: 'openai-agents-sdk',
      tool: 'x.y',
      executed: false,
      schema_version: 1,
    })
    appendFileSync(
      join(auditDir, today, 'x.jsonl'),
      missing + '\n' + VALID('run_ok', 'BLOCKED') + '\n',
    )
    await wait()
    expect(events).toHaveLength(1)
    expect(tailer.parseErrors).toBe(1)
    await tailer.stop()
  })

  it('reads backlog from files that exist before start()', async () => {
    // File present *before* tailer starts.
    writeFileSync(
      join(auditDir, today, 'pre-existing.jsonl'),
      VALID('run_backloga', 'BLOCKED') + '\n' + VALID('run_backlogb', 'AUDIT') + '\n',
    )

    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()
    await wait()

    expect(events.map((e) => e.run_id).sort()).toEqual(['run_backloga', 'run_backlogb'])
    await tailer.stop()
  })

  it('tracks file position across multiple appends without re-emitting', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    const file = join(auditDir, today, 'x.jsonl')
    appendFileSync(file, VALID('run_1', 'BLOCKED') + '\n')
    await wait()
    appendFileSync(file, VALID('run_2', 'BLOCKED') + '\n')
    await wait()
    appendFileSync(file, VALID('run_3', 'BLOCKED') + '\n')
    await wait()

    expect(events.map((e) => e.run_id)).toEqual(['run_1', 'run_2', 'run_3'])
    await tailer.stop()
  })

  it('handles multiple files in the same date dir independently', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(join(auditDir, today, 'a.jsonl'), VALID('run_a', 'BLOCKED') + '\n')
    appendFileSync(join(auditDir, today, 'b.jsonl'), VALID('run_b', 'BLOCKED') + '\n')
    await wait(400)

    expect(events.map((e) => e.run_id).sort()).toEqual(['run_a', 'run_b'])
    await tailer.stop()
  })

  it('ignores non-jsonl files', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()

    appendFileSync(join(auditDir, today, 'README.txt'), VALID('run_a', 'BLOCKED') + '\n')
    await wait()
    expect(events).toHaveLength(0)
    await tailer.stop()
  })

  it('stop() halts further emissions', async () => {
    const tailer = new Tailer({ auditDir, todayDir: today, filter: 'all' })
    const events: AuditEventV1[] = []
    tailer.on('event', (e) => events.push(e))
    await tailer.start()
    await tailer.stop()

    appendFileSync(join(auditDir, today, 'x.jsonl'), VALID('run_a', 'BLOCKED') + '\n')
    await wait()
    expect(events).toHaveLength(0)
  })
})
