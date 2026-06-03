export interface Percentiles {
  p50: number
  p95: number
  p99: number
  mean: number
}

// Nearest-rank percentile over an ascending-sorted copy:
//   pK = sorted[clamp(ceil(K/100 * n) - 1, 0, n-1)]
export function percentiles(samples: number[]): Percentiles {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, mean: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const at = (k: number): number => {
    const idx = Math.min(Math.max(Math.ceil((k / 100) * n) - 1, 0), n - 1)
    return sorted[idx]!
  }
  const mean = sorted.reduce((a, b) => a + b, 0) / n
  return { p50: at(50), p95: at(95), p99: at(99), mean }
}

export interface RunBenchOptions {
  iterations: number
  batch: number
  warmup: number
}

// Batched sampling: amortizes timer overhead for sub-microsecond ops.
// Each sample times `batch` inner calls; per-op ns = (end - start) / batch
// using Number division to preserve fractional nanoseconds.
export function runBench(fn: () => void, opts: RunBenchOptions): Percentiles {
  const { iterations, batch, warmup } = opts
  for (let i = 0; i < warmup; i += 1) fn()
  const samples = Math.floor(iterations / batch)
  const perOp: number[] = []
  for (let s = 0; s < samples; s += 1) {
    const start = process.hrtime.bigint()
    for (let b = 0; b < batch; b += 1) fn()
    const end = process.hrtime.bigint()
    perOp.push(Number(end - start) / batch)
  }
  return percentiles(perOp)
}
