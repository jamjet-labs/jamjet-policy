import { describe, it, expect } from 'vitest'
import { classifyBlastRadius } from '../src/mcp/blast-radius.js'

describe('classifyBlastRadius', () => {
  it('classifies destructive verbs', () => {
    expect(classifyBlastRadius('delete_all')).toBe('destructive')
    expect(classifyBlastRadius('drop_table')).toBe('destructive')
  })
  it('classifies external-send verbs', () => {
    expect(classifyBlastRadius('send_email')).toBe('external_send')
    expect(classifyBlastRadius('post_message')).toBe('external_send')
  })
  it('classifies write verbs', () => {
    expect(classifyBlastRadius('create_file')).toBe('write')
    expect(classifyBlastRadius('update_record')).toBe('write')
  })
  it('classifies read verbs', () => {
    expect(classifyBlastRadius('read_file')).toBe('read')
    expect(classifyBlastRadius('list_dir')).toBe('read')
  })
  it('returns unknown for no match', () => {
    expect(classifyBlastRadius('frobnicate')).toBe('unknown')
  })
  it('is severity-ordered: destructive beats external_send', () => {
    expect(classifyBlastRadius('delete_and_send')).toBe('destructive')
  })
  it('is case-insensitive', () => {
    expect(classifyBlastRadius('DeleteEverything')).toBe('destructive')
  })
})
