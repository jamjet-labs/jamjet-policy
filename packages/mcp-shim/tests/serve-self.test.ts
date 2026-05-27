import { describe, it, expect } from 'vitest'
import {
  buildServeSelfTools,
  handleServeSelfRequest,
  POLICY_TOOL_NAMES,
  type ServeSelfContext,
} from '../src/serve-self.js'
import { PolicyEvaluator } from '@jamjet/cloud'

function ctxFromRules(rules: Array<{ match: string; action: 'allow' | 'block' | 'require_approval' | 'audit' }>): ServeSelfContext {
  const evaluator = new PolicyEvaluator()
  for (const r of rules) evaluator.add(r.action, r.match)
  return {
    policy: {
      version: 1,
      rules,
    },
    evaluator,
    policyPath: '/tmp/test-policy.yaml',
  }
}

describe('serve-self tool catalog', () => {
  it('exposes exactly the three policy tools, in stable order', () => {
    const tools = buildServeSelfTools()
    expect(tools.map((t) => t.name)).toEqual(POLICY_TOOL_NAMES)
    expect(POLICY_TOOL_NAMES).toEqual(['policy_evaluate', 'policy_list_rules', 'policy_load_info'])
  })

  it('every tool has a description longer than 60 chars and an inputSchema with type=object', () => {
    for (const t of buildServeSelfTools()) {
      expect(t.description.length, `${t.name} description too short`).toBeGreaterThan(60)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('policy_evaluate requires tool_name', () => {
    const t = buildServeSelfTools().find((x) => x.name === 'policy_evaluate')!
    expect(t.inputSchema.required).toContain('tool_name')
    expect(t.inputSchema.properties.tool_name.type).toBe('string')
  })
})

describe('handleServeSelfRequest', () => {
  const ctx = ctxFromRules([
    { match: '*delete*', action: 'block' },
    { match: 'payments.*', action: 'require_approval' },
    { match: 'slack.send_message', action: 'audit' },
  ])

  it('initialize returns serverInfo + tools capability', () => {
    const r = handleServeSelfRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx)
    expect(r.id).toBe(1)
    expect(r.result).toBeDefined()
    const result = r.result as { serverInfo: { name: string }; capabilities: { tools: object } }
    expect(result.serverInfo.name).toBe('jamjet-policy')
    expect(result.capabilities.tools).toBeDefined()
  })

  it('tools/list returns all policy tools', () => {
    const r = handleServeSelfRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)
    const result = r.result as { tools: Array<{ name: string }> }
    expect(result.tools.map((t) => t.name)).toEqual(POLICY_TOOL_NAMES)
  })

  it('tools/call policy_evaluate on a blocking pattern returns block decision', () => {
    const r = handleServeSelfRequest(
      {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'policy_evaluate', arguments: { tool_name: 'database.delete_all' } },
      },
      ctx,
    )
    const result = r.result as { content: Array<{ type: string; text: string }>; structuredContent: { decision: string; matched_pattern: string; rule_kind: string } }
    expect(result.structuredContent.decision).toBe('block')
    expect(result.structuredContent.matched_pattern).toBe('*delete*')
    expect(result.structuredContent.rule_kind).toBe('block')
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toMatch(/block/i)
  })

  it('tools/call policy_evaluate on an allow path returns allow + null pattern', () => {
    const r = handleServeSelfRequest(
      {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'policy_evaluate', arguments: { tool_name: 'database.read' } },
      },
      ctx,
    )
    const result = r.result as { structuredContent: { decision: string; matched_pattern: string | null } }
    expect(result.structuredContent.decision).toBe('allow')
    expect(result.structuredContent.matched_pattern).toBeNull()
  })

  it('tools/call policy_list_rules returns rules in policy order', () => {
    const r = handleServeSelfRequest(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'policy_list_rules' } },
      ctx,
    )
    const result = r.result as { structuredContent: { rules: Array<{ index: number; action: string; pattern: string }> } }
    expect(result.structuredContent.rules).toHaveLength(3)
    expect(result.structuredContent.rules[0]).toMatchObject({ index: 0, action: 'block', pattern: '*delete*' })
    expect(result.structuredContent.rules[2]).toMatchObject({ index: 2, action: 'audit', pattern: 'slack.send_message' })
  })

  it('tools/call policy_load_info reports the path and rule count', () => {
    const r = handleServeSelfRequest(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'policy_load_info' } },
      ctx,
    )
    const result = r.result as { structuredContent: { policy_path: string; rules_count: number } }
    expect(result.structuredContent.policy_path).toBe('/tmp/test-policy.yaml')
    expect(result.structuredContent.rules_count).toBe(3)
  })

  it('tools/call with unknown tool name returns JSON-RPC error -32601', () => {
    const r = handleServeSelfRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'made_up_tool' } },
      ctx,
    )
    expect(r.error?.code).toBe(-32601)
    expect(r.error?.message).toMatch(/unknown tool/i)
  })

  it('policy_evaluate without tool_name returns JSON-RPC -32602 invalid params', () => {
    const r = handleServeSelfRequest(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'policy_evaluate', arguments: {} } },
      ctx,
    )
    expect(r.error?.code).toBe(-32602)
  })

  it('unknown method returns -32601', () => {
    const r = handleServeSelfRequest({ jsonrpc: '2.0', id: 9, method: 'not_a_real_method' }, ctx)
    expect(r.error?.code).toBe(-32601)
  })
})
