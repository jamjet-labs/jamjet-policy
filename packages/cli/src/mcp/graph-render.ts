import type { CapabilityGraph, GraphTool } from './graph-model.js'

const RISK_LEGEND = 'risk = heuristic name-pattern classification, not a guarantee'

function formatToolLine(tool: GraphTool): string {
  const rule = tool.rule ? `  (${tool.rule})` : ''
  const risk = tool.risk ? `  [${tool.risk}]` : ''
  return `${tool.name}  ${tool.decision}${rule}${risk}`
}

export function renderText(graph: CapabilityGraph): string {
  const lines: string[] = []
  for (const server of graph.servers) {
    const shortFp = server.fingerprint.slice(0, 17)
    lines.push(`${server.name}  (${shortFp}…)  approved ${server.approved_at}`)
    for (const tool of server.tools) lines.push(`  ${formatToolLine(tool)}`)
    lines.push('')
  }
  if (graph.withRisk) lines.push(`(${RISK_LEGEND})`)
  return lines.join('\n')
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'")
}

export function renderMermaid(graph: CapabilityGraph): string {
  const lines: string[] = ['flowchart LR']
  graph.servers.forEach((server, si) => {
    const sid = `S${si}`
    lines.push(`  ${sid}["${escapeMermaid(server.name)}"]`)
    server.tools.forEach((tool, ti) => {
      const tid = `${sid}T${ti}`
      const risk = tool.risk ? ` / ${tool.risk}` : ''
      lines.push(`  ${sid} --> ${tid}["${escapeMermaid(tool.name)}<br/>${tool.decision}${risk}"]`)
    })
  })
  return lines.join('\n')
}

export function renderJson(graph: CapabilityGraph): string {
  return JSON.stringify(graph, null, 2)
}
