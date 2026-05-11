import { describe, it, expect } from 'vitest'
import { parseClaudeToolName } from '../src/claude-tool-name.js'

describe('parseClaudeToolName', () => {
  it('strips mcp__server__ prefix', () => {
    const r = parseClaudeToolName('mcp__postgres__delete_all_customers')
    expect(r.effective).toBe('delete_all_customers')
    expect(r.server).toBe('postgres')
    expect(r.raw).toBe('mcp__postgres__delete_all_customers')
  })

  it('handles multi-segment server names', () => {
    const r = parseClaudeToolName('mcp__my_server_name__tool.x')
    expect(r.effective).toBe('tool.x')
    expect(r.server).toBe('my_server_name')
  })

  it('leaves non-mcp tool names unchanged', () => {
    const r = parseClaudeToolName('Bash')
    expect(r.effective).toBe('Bash')
    expect(r.server).toBe(null)
  })

  it('leaves tool names without proper mcp prefix unchanged', () => {
    const r = parseClaudeToolName('not_mcp__only_two')
    expect(r.effective).toBe('not_mcp__only_two')
    expect(r.server).toBe(null)
  })
})
