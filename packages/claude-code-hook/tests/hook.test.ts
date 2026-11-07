import { describe, it, expect } from 'vitest'
import { evaluateHookInput } from '../src/hook.js'
import { PolicyEvaluator } from '@jamjet/cloud'

function evaluator(rules: Array<['allow' | 'block' | 'require_approval' | 'audit', string]>) {
  const ev = new PolicyEvaluator()
  for (const [action, pattern] of rules) ev.add(action, pattern)
  return ev
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
})
