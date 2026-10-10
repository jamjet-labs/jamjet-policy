/**
 * The `mcp:` block of policy.yaml: protocol, pinning and deprecation settings
 * for the stdio shim. Invalid values throw at startup. A typo in a security
 * setting must not quietly fall back to a default.
 *
 *   mcp:
 *     protocol:
 *       unknown_versions: refuse      # refuse | pass
 *     pinning:
 *       mode: tofu                    # tofu | allowlist | off
 *       file: ~/.jamjet/mcp-tool-pins.json
 *       prefetch_timeout_ms: 5000
 *     invisible_unicode: block        # block | warn
 *     deprecated:
 *       sampling: warn                # pass | warn | block
 *       roots: warn
 *       logging: pass
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { PinMode } from './tool-pins.js'

export type DeprecatedAction = 'pass' | 'warn' | 'block'
export type DeprecatedFeature = 'sampling' | 'roots' | 'logging'

export interface ShimMcpConfig {
  unknownVersions: 'refuse' | 'pass'
  pinning: { mode: PinMode; file: string; prefetchTimeoutMs: number }
  invisibleUnicode: 'block' | 'warn'
  deprecated: Record<DeprecatedFeature, DeprecatedAction>
}

export const SHIM_CONFIG_DEFAULTS: ShimMcpConfig = Object.freeze({
  unknownVersions: 'refuse',
  pinning: { mode: 'tofu', file: '~/.jamjet/mcp-tool-pins.json', prefetchTimeoutMs: 5000 },
  invisibleUnicode: 'block',
  deprecated: { sampling: 'warn', roots: 'warn', logging: 'pass' },
}) as ShimMcpConfig

function obj(v: unknown, label: string): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`policy ${label} must be a mapping`)
  return v as Record<string, unknown>
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], label: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new Error(`policy ${label}.${k} is not a recognised setting (expected one of: ${allowed.join(', ')})`)
  }
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (v === undefined) return fallback
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  throw new Error(`policy ${label} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(v)})`)
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p
}

export function parseShimConfig(policyDoc: unknown, home: string, env: NodeJS.ProcessEnv): ShimMcpConfig {
  const root = obj(policyDoc, 'document')
  const mcp = obj(root.mcp, 'mcp')
  onlyKeys(mcp, ['protocol', 'pinning', 'invisible_unicode', 'deprecated'], 'mcp')
  const protocol = obj(mcp.protocol, 'mcp.protocol')
  onlyKeys(protocol, ['unknown_versions'], 'mcp.protocol')
  const pinning = obj(mcp.pinning, 'mcp.pinning')
  onlyKeys(pinning, ['mode', 'file', 'prefetch_timeout_ms'], 'mcp.pinning')
  const deprecated = obj(mcp.deprecated, 'mcp.deprecated')
  onlyKeys(deprecated, ['sampling', 'roots', 'logging'], 'mcp.deprecated')

  const d = SHIM_CONFIG_DEFAULTS
  let file: string
  if (pinning.file !== undefined) {
    if (typeof pinning.file !== 'string' || pinning.file.length === 0) throw new Error('policy mcp.pinning.file must be a non-empty string')
    file = pinning.file
  } else {
    file = env.JAMJET_TOOL_PINS || d.pinning.file
  }

  let timeout = d.pinning.prefetchTimeoutMs
  if (pinning.prefetch_timeout_ms !== undefined) {
    const t = pinning.prefetch_timeout_ms
    if (!(typeof t === 'number' && Number.isInteger(t) && t > 0 && t <= 600_000)) {
      throw new Error('policy mcp.pinning.prefetch_timeout_ms must be an integer between 1 and 600000')
    }
    timeout = t
  }

  const dep = (k: DeprecatedFeature) => oneOf(deprecated[k], ['pass', 'warn', 'block'] as const, d.deprecated[k], `mcp.deprecated.${k}`)
  return {
    unknownVersions: oneOf(protocol.unknown_versions, ['refuse', 'pass'] as const, d.unknownVersions, 'mcp.protocol.unknown_versions'),
    pinning: {
      mode: oneOf(pinning.mode, ['tofu', 'allowlist', 'off'] as const, d.pinning.mode, 'mcp.pinning.mode'),
      file: expandHome(file, home),
      prefetchTimeoutMs: timeout,
    },
    invisibleUnicode: oneOf(mcp.invisible_unicode, ['block', 'warn'] as const, d.invisibleUnicode, 'mcp.invisible_unicode'),
    deprecated: { sampling: dep('sampling'), roots: dep('roots'), logging: dep('logging') },
  }
}

/** Same discovery order as @jamjet/cloud's loadPolicy. */
export function resolvePolicyPath(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicit) return explicit
  if (env.JAMJET_POLICY_FILE) return env.JAMJET_POLICY_FILE
  const cwd = join(process.cwd(), 'policy.yaml')
  if (existsSync(cwd)) return cwd
  const home = join(homedir(), '.jamjet', 'policy.yaml')
  if (existsSync(home)) return home
  return undefined
}

export function loadShimConfig(policyPath: string | undefined): ShimMcpConfig {
  const doc = policyPath ? parse(readFileSync(policyPath, 'utf-8')) : {}
  return parseShimConfig(doc, homedir(), process.env)
}
