import { describe, it, expect } from 'vitest'
import { renderText, renderMermaid, renderJson } from '../src/mcp/graph-render.js'
import type { CapabilityGraph } from '../src/mcp/graph-model.js'

const graph: CapabilityGraph = {
  withRisk: false,
  servers: [{
    name: 'demo',
    fingerprint: 'sha256:abcdef0123456789',
    approved_at: '2026-06-03T00:00:00.000Z',
    tools: [
      { name: 'read_file', decision: 'allow', rule: null },
      { name: 'delete_all', decision: 'block', rule: '*delete*' },
    ],
  }],
}

const graphRisk: CapabilityGraph = {
  withRisk: true,
  servers: [{
    name: 'demo',
    fingerprint: 'sha256:abcdef0123456789',
    approved_at: '2026-06-03T00:00:00.000Z',
    tools: [{ name: 'delete_all', decision: 'block', rule: '*delete*', risk: 'destructive' }],
  }],
}

describe('renderText', () => {
  it('shows server, tools, and decisions', () => {
    const out = renderText(graph)
    expect(out).toContain('demo')
    expect(out).toContain('read_file  allow')
    expect(out).toContain('delete_all  block  (*delete*)')
  })
  it('shows the legend and bucket only with risk', () => {
    expect(renderText(graph)).not.toContain('heuristic name-pattern')
    const risky = renderText(graphRisk)
    expect(risky).toContain('[destructive]')
    expect(risky).toContain('heuristic name-pattern')
  })
})

describe('renderMermaid', () => {
  it('emits a flowchart with a server->tool edge', () => {
    const out = renderMermaid(graph)
    expect(out.startsWith('flowchart LR')).toBe(true)
    expect(out).toContain('S0 --> S0T0')
    expect(out).toContain('read_file')
  })
  it('neutralizes quotes and newlines in names', () => {
    const g: CapabilityGraph = {
      withRisk: false,
      servers: [{ name: 'srv', fingerprint: 'sha256:abc', approved_at: '2026-06-03T00:00:00.000Z',
        tools: [{ name: 'we"ird\nname', decision: 'allow', rule: null }] }],
    }
    const out = renderMermaid(g)
    expect(out).not.toContain('"we"')          // inner double-quote neutralized
    expect(out.split('\n').every((l) => !l.startsWith('name'))).toBe(true) // no bare newline break
  })
})

describe('renderJson', () => {
  it('round-trips to the model', () => {
    expect(JSON.parse(renderJson(graph))).toEqual(graph)
  })
})
