import { describe, it, expect } from 'vitest'
import { percentiles, runBench } from '../src/mcp/bench-harness.js'

describe('percentiles', () => {
  it('computes nearest-rank percentiles and mean on [1..100]', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    const p = percentiles(samples)
    expect(p.p50).toBe(50)
    expect(p.p95).toBe(95)
    expect(p.p99).toBe(99)
    expect(p.mean).toBe(50.5)
  })
  it('is order-independent', () => {
    expect(percentiles([3, 1, 2])).toEqual(percentiles([1, 2, 3]))
  })
  it('returns zeros for an empty sample set', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, mean: 0 })
  })
})

describe('runBench', () => {
  it('calls fn warmup + samples*batch times and returns ordered percentiles', () => {
    let calls = 0
    const fn = (): void => { calls += 1 }
    const p = runBench(fn, { iterations: 1000, batch: 100, warmup: 50 })
    expect(calls).toBe(50 + 1000) // warmup 50 + floor(1000/100)=10 samples * 100 batch
    expect(p.p50).toBeLessThanOrEqual(p.p95)
    expect(p.p95).toBeLessThanOrEqual(p.p99)
    expect(Number.isFinite(p.mean)).toBe(true)
    expect(p.p50).toBeGreaterThanOrEqual(0)
  })
})
