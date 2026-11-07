// Command-line flags and policy file selection.
//
// The policy file is never picked up from the working directory. Claude Code
// runs hooks with the project as cwd, so a cwd lookup would let any repository
// ship a policy.yaml that replaces the user's own.

import { isAbsolute, join } from 'node:path'

export interface HookArgs {
  policy?: string
  allowAuditFailure: boolean
}

/** Parse argv. Unknown or malformed flags throw, so a typo cannot silently drop a setting. */
export function parseArgs(argv: string[]): HookArgs {
  const out: HookArgs = { allowAuditFailure: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--policy' || arg.startsWith('--policy=')) {
      if (out.policy !== undefined) throw new Error('--policy given more than once')
      const value = arg === '--policy' ? argv[++i] : arg.slice('--policy='.length)
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--policy needs a file path')
      }
      out.policy = value
    } else if (arg === '--allow-audit-failure') {
      out.allowAuditFailure = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

export type PolicySource = '--policy' | 'JAMJET_POLICY_FILE' | 'JAMJET_POLICY' | 'default'

export interface ResolvedPolicyPath {
  path: string
  source: PolicySource
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/**
 * `--policy <path>`, else `JAMJET_POLICY_FILE` (or its alias `JAMJET_POLICY`),
 * else `~/.jamjet/policy.yaml`. Nothing else is consulted, and the result must
 * be absolute: a relative path would resolve against the project directory.
 */
export function resolvePolicyPath(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  home: string,
): ResolvedPolicyPath {
  if (!isAbsolute(home)) {
    throw new Error(`home directory ${JSON.stringify(home)} is not an absolute path`)
  }

  let raw: string
  let source: PolicySource
  const file = env.JAMJET_POLICY_FILE || undefined
  const alias = env.JAMJET_POLICY || undefined
  if (flag !== undefined) {
    raw = flag
    source = '--policy'
  } else if (file !== undefined && alias !== undefined && file !== alias) {
    throw new Error('JAMJET_POLICY_FILE and JAMJET_POLICY are both set to different files; set one')
  } else if (file !== undefined) {
    raw = file
    source = 'JAMJET_POLICY_FILE'
  } else if (alias !== undefined) {
    raw = alias
    source = 'JAMJET_POLICY'
  } else {
    return { path: join(home, '.jamjet', 'policy.yaml'), source: 'default' }
  }

  const path = expandHome(raw, home)
  if (!isAbsolute(path)) {
    throw new Error(`${source} ${JSON.stringify(raw)} is a relative path, which would resolve against the project directory; use an absolute path`)
  }
  return { path, source }
}
