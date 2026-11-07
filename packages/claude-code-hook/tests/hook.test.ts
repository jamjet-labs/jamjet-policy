import { describe, it, expect } from 'vitest'
import { evaluateHookInput } from '../src/hook.js'
import type { HookRule } from '../src/policy.js'

function evaluator(rules: Array<['allow' | 'block' | 'require_approval' | 'audit', string]>): HookRule[] {
  return rules.map(([action, match]) => ({ action, match }))
}

describe('evaluateHookInput', () => {
  it('BLOCKED for matching block rule', () => {
    const ev = evaluator([['block', '*delete*']])
    const r = evaluateHookInput(
      { tool_name: 'database.delete_all', tool_input: {} },
      ev,
    )
    expect(r.decision).toBe('BLOCKED')
    expect(r.rule).toBe('*delete*')
    expect(r.rule_kind).toBe('block')
  })

  it('ALLOWED for no match', () => {
    const ev = evaluator([['block', '*delete*']])
    const r = evaluateHookInput(
      { tool_name: 'database.read', tool_input: {} },
      ev,
    )
    expect(r.decision).toBe('ALLOWED')
    expect(r.rule).toBeNull()
  })

  it('strips mcp__server__ prefix before matching', () => {
    const ev = evaluator([['block', '*delete*']])
    const r = evaluateHookInput(
      { tool_name: 'mcp__pg__database.delete_x', tool_input: {} },
      ev,
    )
    expect(r.decision).toBe('BLOCKED')
    expect(r.effective_tool).toBe('database.delete_x')
    expect(r.server).toBe('pg')
  })

  it('WAITING_FOR_APPROVAL for approval rules', () => {
    const ev = evaluator([['require_approval', 'payments.*']])
    const r = evaluateHookInput(
      { tool_name: 'payments.refund', tool_input: { amount: 100 } },
      ev,
    )
    expect(r.decision).toBe('WAITING_FOR_APPROVAL')
    expect(r.rule).toBe('payments.*')
  })

  it('AUDIT for audit rules', () => {
    const ev = evaluator([['audit', 'slack.send_message']])
    const r = evaluateHookInput(
      { tool_name: 'slack.send_message', tool_input: {} },
      ev,
    )
    expect(r.decision).toBe('AUDIT')
  })

  describe('MCP tools', () => {
    it('an allow for a built-in name does not allow an MCP tool of that name', () => {
      const ev = evaluator([['allow', 'Read'], ['block', '*']])
      expect(evaluateHookInput({ tool_name: 'Read', tool_input: {} }, ev).decision).toBe('ALLOWED')
      const r = evaluateHookInput({ tool_name: 'mcp__evil__Read', tool_input: {} }, ev)
      expect(r.decision).toBe('BLOCKED')
      expect(r.rule).toBe('*')
    })

    it('a full-name allow works ahead of a catch-all block', () => {
      const ev = evaluator([['allow', 'mcp__github__*'], ['block', '*']])
      expect(evaluateHookInput({ tool_name: 'mcp__github__create_issue', tool_input: {} }, ev).decision).toBe('ALLOWED')
      expect(evaluateHookInput({ tool_name: 'mcp__gitlab__create_issue', tool_input: {} }, ev).decision).toBe('BLOCKED')
    })

    it('block, ask and audit rules also match the bare MCP tool name', () => {
      const ev = evaluator([['block', 'delete_rows'], ['require_approval', 'merge_pull_request'], ['audit', 'search']])
      expect(evaluateHookInput({ tool_name: 'mcp__pg__delete_rows', tool_input: {} }, ev).decision).toBe('BLOCKED')
      expect(evaluateHookInput({ tool_name: 'mcp__github__merge_pull_request', tool_input: {} }, ev).decision).toBe(
        'WAITING_FOR_APPROVAL',
      )
      expect(evaluateHookInput({ tool_name: 'mcp__web__search', tool_input: {} }, ev).decision).toBe('AUDIT')
    })
  })
})

