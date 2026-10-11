import { describe, it, expect } from 'vitest'
import { parseShimConfig, SHIM_CONFIG_DEFAULTS } from '../src/shim-config.js'

const HOME = '/home/u'

describe('parseShimConfig', () => {
  it('defaults when the policy has no mcp block', () => {
    expect(parseShimConfig({ version: 1, rules: [] }, HOME, {})).toEqual({
      ...SHIM_CONFIG_DEFAULTS,
      pinning: { ...SHIM_CONFIG_DEFAULTS.pinning, file: '/home/u/.jamjet/mcp-tool-pins.json' },
    })
  })

  it('documents the chosen defaults', () => {
    expect(SHIM_CONFIG_DEFAULTS.unknownVersions).toBe('refuse')
    expect(SHIM_CONFIG_DEFAULTS.pinning.mode).toBe('tofu')
    expect(SHIM_CONFIG_DEFAULTS.invisibleUnicode).toBe('block')
    expect(SHIM_CONFIG_DEFAULTS.deprecated).toEqual({ sampling: 'warn', roots: 'warn', logging: 'pass' })
  })

  it('reads every field and expands ~ in the pin file path', () => {
    const cfg = parseShimConfig({
      mcp: {
        protocol: { unknown_versions: 'pass' },
        pinning: { mode: 'allowlist', file: '~/pins.json', prefetch_timeout_ms: 1500 },
        invisible_unicode: 'warn',
        deprecated: { sampling: 'block', roots: 'pass', logging: 'warn' },
      },
    }, HOME, {})
    expect(cfg).toEqual({
      unknownVersions: 'pass',
      pinning: { mode: 'allowlist', file: '/home/u/pins.json', prefetchTimeoutMs: 1500 },
      invisibleUnicode: 'warn',
      deprecated: { sampling: 'block', roots: 'pass', logging: 'warn' },
    })
  })

  it('takes the pin file from JAMJET_TOOL_PINS when the policy does not set one', () => {
    expect(parseShimConfig({}, HOME, { JAMJET_TOOL_PINS: '/etc/pins.json' }).pinning.file).toBe('/etc/pins.json')
    expect(parseShimConfig({ mcp: { pinning: { file: '/p.json' } } }, HOME, { JAMJET_TOOL_PINS: '/etc/pins.json' }).pinning.file).toBe('/p.json')
  })

  it.each([
    [{ mcp: { protocol: { unknown_versions: 'allow' } } }, /unknown_versions/],
    [{ mcp: { pinning: { mode: 'tofU' } } }, /pinning.mode/],
    [{ mcp: { pinning: { prefetch_timeout_ms: -1 } } }, /prefetch_timeout_ms/],
    [{ mcp: { pinning: { prefetch_timeout_ms: Number.NaN } } }, /prefetch_timeout_ms/],
    [{ mcp: { pinning: { file: 42 } } }, /pinning.file/],
    [{ mcp: { invisible_unicode: 'ignore' } }, /invisible_unicode/],
    [{ mcp: { deprecated: { sampling: 'deny' } } }, /deprecated.sampling/],
    [{ mcp: { deprecated: { elicitation: 'block' } } }, /deprecated.elicitation/],
    [{ mcp: { pinnning: {} } }, /pinnning/],
    [{ mcp: 'yes' }, /mcp/],
  ])('rejects invalid config %j instead of silently defaulting', (doc, msg) => {
    expect(() => parseShimConfig(doc, HOME, {})).toThrow(msg)
  })
})
