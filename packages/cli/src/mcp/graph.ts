import { loadTrustBaseline, defaultTrustLockPath } from '@jamjet/mcp-threat'
import { PolicyEvaluator } from '@jamjet/cloud'
import { loadPolicy } from '@jamjet/cloud/node'
import { buildCapabilityGraph } from './graph-model.js'
import { renderText, renderMermaid, renderJson } from './graph-render.js'

export type GraphFormat = 'text' | 'mermaid' | 'json'

export interface McpGraphOptions {
  format: GraphFormat
  risk: boolean
  lockPath?: string
  policyPath?: string
}

export function mcpGraph(opts: McpGraphOptions): void {
  const lockPath = opts.lockPath ?? defaultTrustLockPath()
  const baseline = loadTrustBaseline(lockPath)
  if (Object.keys(baseline.servers).length === 0) {
    process.stdout.write('No servers approved yet. Run `jamjet mcp trust approve <name>`.\n')
    return
  }

  const evaluator = new PolicyEvaluator()
  try {
    const policy = loadPolicy(opts.policyPath)
    for (const r of policy.rules) evaluator.add(r.action, r.match)
  } catch {
    process.stderr.write('no policy found; showing all tools as allow\n')
  }

  const graph = buildCapabilityGraph({ baseline, evaluator, withRisk: opts.risk })
  let out: string
  if (opts.format === 'mermaid') out = renderMermaid(graph)
  else if (opts.format === 'json') out = renderJson(graph)
  else out = renderText(graph)
  process.stdout.write(out.endsWith('\n') ? out : out + '\n')
}
