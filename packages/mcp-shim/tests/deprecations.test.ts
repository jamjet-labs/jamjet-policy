import { describe, it, expect } from 'vitest'
import { classifyDeprecated, deprecatedInputRequests } from '../src/deprecations.js'

const req = (method: string) => ({ jsonrpc: '2.0', id: 9, method, params: {} })
const note = (method: string) => ({ jsonrpc: '2.0', method, params: {} })

describe('classifyDeprecated', () => {
  it('server-to-client sampling and roots requests', () => {
    expect(classifyDeprecated('from_server', req('sampling/createMessage'))).toBe('sampling')
    expect(classifyDeprecated('from_server', req('roots/list'))).toBe('roots')
  })
  it('server log notifications', () => {
    expect(classifyDeprecated('from_server', note('notifications/message'))).toBe('logging')
  })
  it('client logging/setLevel and roots list_changed', () => {
    expect(classifyDeprecated('from_client', req('logging/setLevel'))).toBe('logging')
    expect(classifyDeprecated('from_client', note('notifications/roots/list_changed'))).toBe('roots')
  })
  it('direction matters: a client cannot be the sampling requester', () => {
    expect(classifyDeprecated('from_client', req('sampling/createMessage'))).toBeNull()
    expect(classifyDeprecated('from_server', req('logging/setLevel'))).toBeNull()
  })
  it('a server response is never a deprecated-feature message', () => {
    expect(classifyDeprecated('from_server', { jsonrpc: '2.0', id: 1, result: {} })).toBeNull()
  })
  it('non-deprecated methods', () => {
    expect(classifyDeprecated('from_server', req('elicitation/create'))).toBeNull()
    expect(classifyDeprecated('from_client', req('tools/call'))).toBeNull()
  })
})

describe('deprecatedInputRequests (MRTR)', () => {
  it('finds sampling and roots inside an input_required result', () => {
    const result = {
      resultType: 'input_required',
      inputRequests: {
        login: { method: 'elicitation/create', params: {} },
        cap: { method: 'sampling/createMessage', params: {} },
        dirs: { method: 'roots/list' },
      },
    }
    expect(deprecatedInputRequests(result)).toEqual([
      { key: 'cap', feature: 'sampling' },
      { key: 'dirs', feature: 'roots' },
    ])
  })
  it('ignores complete results and malformed inputRequests', () => {
    expect(deprecatedInputRequests({ resultType: 'complete', inputRequests: { a: { method: 'sampling/createMessage' } } })).toEqual([])
    expect(deprecatedInputRequests({ resultType: 'input_required', inputRequests: 'x' })).toEqual([])
    expect(deprecatedInputRequests(null)).toEqual([])
  })
})
