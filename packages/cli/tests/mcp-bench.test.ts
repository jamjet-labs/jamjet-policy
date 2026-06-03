import { describe, it, expect, vi, afterEach } from 'vitest'
import { mcpBench, runBenchResult } from '../src/mcp/bench.js'

afterEach(() => { vi.restoreAllMocks() })

describe('runBenchResult', () => {
  it('returns both paths with ordered percentiles and toolCount 10', () => {
    const r = runBenchResult(200)
    expect(r.iterations).toBe(200)
    expect(r.paths.listDriftCheck.toolCount).toBe(10)
    for (const p of [r.paths.callEnforcement, r.paths.listDriftCheck]) {
      expect(p.p50).toBeLessThanOrEqual(p.p95)
      expect(p.p95).toBeLessThanOrEqual(p.p99)
      expect(Number.isFinite(p.mean)).toBe(true)
    }
  })
})

describe('mcpBench', () => {
  it('prints text with both path labels and percentile labels', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mcpBench({ iterations: 200, format: 'text' })
    const text = out.mock.calls.join('')
    expect(text).toContain('tools/call enforcement')
    expect(text).toContain('tools/list drift check')
    expect(text).toContain('p50')
    expect(text).toContain('p99')
  })

  it('emits parseable JSON with format json', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mcpBench({ iterations: 200, format: 'json' })
    const parsed = JSON.parse(out.mock.calls.join('')) as { paths: { listDriftCheck: { toolCount: number } } }
    expect(parsed.paths.listDriftCheck.toolCount).toBe(10)
  })
})
