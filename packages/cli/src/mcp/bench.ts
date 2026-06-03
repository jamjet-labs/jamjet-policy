import {
  approveServer,
  evaluateCall,
  evaluateToolsList,
  THREAT_DEFAULTS,
  type ToolDefinition,
  type ThreatFinding,
} from '@jamjet/mcp-threat'
import { runBench, type Percentiles } from './bench-harness.js'

export type BenchFormat = 'text' | 'json'

export interface McpBenchOptions {
  iterations: number
  format: BenchFormat
}

export interface BenchResult {
  iterations: number
  batch: number
  paths: {
    callEnforcement: Percentiles
    listDriftCheck: Percentiles & { toolCount: number }
  }
}

const BATCH = 100
const WARMUP = 1000

function tenTools(): ToolDefinition[] {
  return Array.from({ length: 10 }, (_, i) => ({
    name: `tool_${i}`,
    description: `tool number ${i}`,
    inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
  }))
}

export function runBenchResult(iterations: number): BenchResult {
  const tools = tenTools()
  const baseline = approveServer(
    { version: 1, servers: {} }, 'demo', 'sha256:demo', tools, '2026-06-03T00:00:00.000Z',
  )
  const emptyFlagged = new Map<string, ThreatFinding>()

  const callEnforcement = runBench(() => {
    evaluateCall({
      server: 'demo', tool: 'tool_0', args: { arg: 'x' },
      flagged: emptyFlagged, serverUnverified: false, config: THREAT_DEFAULTS,
    })
  }, { iterations, batch: BATCH, warmup: WARMUP })

  const listDrift = runBench(() => {
    evaluateToolsList('demo', tools, baseline, THREAT_DEFAULTS)
  }, { iterations, batch: BATCH, warmup: WARMUP })

  return {
    iterations,
    batch: BATCH,
    paths: {
      callEnforcement,
      listDriftCheck: { ...listDrift, toolCount: tools.length },
    },
  }
}

function us(ns: number): string {
  return `${(ns / 1000).toFixed(2)}µs`
}

function renderText(r: BenchResult): string {
  const c = r.paths.callEnforcement
  const l = r.paths.listDriftCheck
  return [
    'jamjet mcp threat control-logic overhead',
    '(in-process; excludes stdio/JSON transport; timings are machine-dependent)',
    `${r.iterations} ops/path`,
    '',
    'tools/call enforcement (clean allowed call)',
    `  p50 ${us(c.p50)}   p95 ${us(c.p95)}   p99 ${us(c.p99)}   mean ${us(c.mean)}`,
    '',
    `tools/list drift check (verified server, ${l.toolCount} tools)`,
    `  p50 ${us(l.p50)}   p95 ${us(l.p95)}   p99 ${us(l.p99)}   mean ${us(l.mean)}`,
  ].join('\n')
}

export function mcpBench(opts: McpBenchOptions): void {
  const result = runBenchResult(opts.iterations)
  const out = opts.format === 'json' ? JSON.stringify(result, null, 2) : renderText(result)
  process.stdout.write(out + '\n')
}
