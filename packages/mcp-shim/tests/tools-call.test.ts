import { describe, it, expect } from 'vitest'
import { interceptToolsCall, blockResponse } from '../src/tools-call.js'
import { PolicyEvaluator } from '@jamjet/cloud'

describe('interceptToolsCall', () => {
  const policy = (() => {
    const ev = new PolicyEvaluator()
    ev.add('block', '*delete*')
    ev.add('require_approval', 'payments.*')
    ev.add('audit', 'slack.send_message')
    return ev
  })()

  it('returns BLOCKED decision for matching block rule', () => {
    const req = {
      jsonrpc: '2.0' as const, id: 1, method: 'tools/call',
      params: { name: 'database.delete_all', arguments: {} },
    }
    const result = interceptToolsCall(req, policy)
    expect(result?.decision).toBe('BLOCKED')
    expect(result?.rule).toBe('*delete*')
    expect(result?.rule_kind).toBe('block')
  })

  it('returns ALLOWED for non-matching', () => {
    const req = {
      jsonrpc: '2.0' as const, id: 2, method: 'tools/call',
      params: { name: 'database.read', arguments: {} },
    }
    const result = interceptToolsCall(req, policy)
    expect(result?.decision).toBe('ALLOWED')
  })

  it('returns WAITING_FOR_APPROVAL for approval rules', () => {
    const req = {
      jsonrpc: '2.0' as const, id: 3, method: 'tools/call',
      params: { name: 'payments.refund', arguments: { amount: 100 } },
    }
    const result = interceptToolsCall(req, policy)
    expect(result?.decision).toBe('WAITING_FOR_APPROVAL')
    expect(result?.rule_kind).toBe('require_approval')
  })

  it('returns AUDIT for audit rules', () => {
    const req = {
      jsonrpc: '2.0' as const, id: 4, method: 'tools/call',
      params: { name: 'slack.send_message', arguments: {} },
    }
    const result = interceptToolsCall(req, policy)
    expect(result?.decision).toBe('AUDIT')
    expect(result?.rule_kind).toBe('audit')
  })

  it('returns null for non-tools/call methods', () => {
    const req = {
      jsonrpc: '2.0' as const, id: 5, method: 'tools/list',
    }
    expect(interceptToolsCall(req, policy)).toBeNull()
  })

  it('blockResponse produces a valid JSON-RPC error response', () => {
    const resp = blockResponse(42, '*delete*')
    expect(resp.id).toBe(42)
    expect(resp.error?.code).toBe(-32000)
    expect(resp.error?.message).toMatch(/policy/i)
    expect(resp.error?.message).toMatch(/\*delete\*/)
  })
})
