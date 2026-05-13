import { describe, it, expect, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalPoller } from '../src/sync/approval-poller.js'
import { HaltedError, type CloudClient } from '../src/cloud/http.js'

function setupPendingDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jamjet-poller-test-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  return {
    pendingDir: join(dir, 'pending'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('ApprovalPoller', () => {
  it('finds PENDING approvals and queries Cloud for decisions', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    writeFileSync(
      join(pendingDir, 'run_b.json'),
      JSON.stringify({ run_id: 'run_b', status: 'pending', tool: 'y' }),
    )

    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_a', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z', decided_by: 'sdev' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()

    expect(client.approvalsPending).toHaveBeenCalledWith(expect.arrayContaining(['run_a', 'run_b']))
    expect(existsSync(join(pendingDir, 'resolved', 'run_a.approved'))).toBe(true)
    expect(existsSync(join(pendingDir, 'run_a.json'))).toBe(false)
    expect(existsSync(join(pendingDir, 'run_b.json'))).toBe(true)
    cleanup()
  })

  it('writes rejected marker on REJECTED decision', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_x.json'),
      JSON.stringify({ run_id: 'run_x', status: 'pending', tool: 'z' }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_x', status: 'REJECTED', decided_at: '2026-05-12T00:00:00Z' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(existsSync(join(pendingDir, 'resolved', 'run_x.rejected'))).toBe(true)
    cleanup()
  })

  it('marker contains pending data merged with decision metadata', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'payments.refund', args: { amount: 100 } }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_a', status: 'APPROVED', decided_at: '2026-05-12T00:01:00Z', decided_by: 'sdev' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()

    const marker = JSON.parse(readFileSync(join(pendingDir, 'resolved', 'run_a.approved'), 'utf-8'))
    expect(marker.run_id).toBe('run_a')
    expect(marker.tool).toBe('payments.refund')
    expect(marker.args).toEqual({ amount: 100 })
    expect(marker.status).toBe('approved')
    expect(marker.decided_at).toBe('2026-05-12T00:01:00Z')
    expect(marker.decided_by).toBe('sdev')
    expect(marker.source).toBe('cloud')
    cleanup()
  })

  it('no-op when no pending files exist', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    const client = { approvalsPending: vi.fn() } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(client.approvalsPending).not.toHaveBeenCalled()
    cleanup()
  })

  it('no-op when pending dir does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamjet-poller-test-'))
    const client = { approvalsPending: vi.fn() } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir: join(dir, 'missing'), client })
    await poller.tick()
    expect(client.approvalsPending).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts round-trips', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    writeFileSync(
      join(pendingDir, 'run_b.json'),
      JSON.stringify({ run_id: 'run_b', status: 'pending', tool: 'y' }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_a', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z' },
        { run_id: 'run_b', status: 'REJECTED', decided_at: '2026-05-12T00:00:00Z' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(poller.totalRoundTripped).toBe(2)
    cleanup()
  })

  it('ignores decisions for unknown run_ids (race: deleted locally before tick)', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_a', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z' },
        { run_id: 'run_gone', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(existsSync(join(pendingDir, 'resolved', 'run_a.approved'))).toBe(true)
    expect(existsSync(join(pendingDir, 'resolved', 'run_gone.approved'))).toBe(false)
    expect(poller.totalRoundTripped).toBe(1)
    cleanup()
  })

  it('skips EXPIRED decisions (no marker written)', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_a', status: 'EXPIRED', decided_at: '2026-05-12T00:00:00Z' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(existsSync(join(pendingDir, 'resolved', 'run_a.approved'))).toBe(false)
    expect(existsSync(join(pendingDir, 'resolved', 'run_a.rejected'))).toBe(false)
    expect(existsSync(join(pendingDir, 'run_a.json'))).toBe(true)
    cleanup()
  })

  it('emits halted event on HaltedError (does not crash)', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    const client = {
      approvalsPending: vi.fn().mockRejectedValue(new HaltedError('401')),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    let halted = false
    poller.on('halted', () => {
      halted = true
    })
    await poller.tick()
    expect(halted).toBe(true)
    expect(poller.halted).toBe(true)
    cleanup()
  })

  it('skips ticks while halted', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(
      join(pendingDir, 'run_a.json'),
      JSON.stringify({ run_id: 'run_a', status: 'pending', tool: 'x' }),
    )
    const client = {
      approvalsPending: vi.fn().mockRejectedValue(new HaltedError('401')),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    await poller.tick()
    await poller.tick()
    expect((client.approvalsPending as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    cleanup()
  })

  it('ignores corrupted pending JSON without crashing', async () => {
    const { pendingDir, cleanup } = setupPendingDir()
    writeFileSync(join(pendingDir, 'run_bad.json'), '{not valid')
    writeFileSync(
      join(pendingDir, 'run_ok.json'),
      JSON.stringify({ run_id: 'run_ok', status: 'pending', tool: 'x' }),
    )
    const client = {
      approvalsPending: vi.fn().mockResolvedValue([
        { run_id: 'run_bad', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z' },
        { run_id: 'run_ok', status: 'APPROVED', decided_at: '2026-05-12T00:00:00Z' },
      ]),
    } as unknown as CloudClient
    const poller = new ApprovalPoller({ pendingDir, client })
    await poller.tick()
    expect(existsSync(join(pendingDir, 'resolved', 'run_ok.approved'))).toBe(true)
    expect(existsSync(join(pendingDir, 'resolved', 'run_bad.approved'))).toBe(false)
    cleanup()
  })
})
