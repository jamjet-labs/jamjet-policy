import type { Policy } from '@jamjet/cloud'

export const DEMO_POLICY: Policy = {
  version: 1,
  rules: [
    { match: '*delete*', action: 'block' },
    { match: '*drop*', action: 'block' },
    { match: '*destructive*', action: 'require_approval' },
    { match: 'payments.*', action: 'require_approval' },
  ],
}

export const DEMO_POLICY_WARNING =
  '⚠ jamjet-mcp-shim --serve-self: no policy file found; using the built-in demo policy (' +
  `${DEMO_POLICY.rules.length} illustrative rules). ` +
  'Set --policy <path> or JAMJET_POLICY_FILE to bind your real rules.'

export type PolicySource = 'file' | 'demo'

export interface BootstrapResult {
  policy: Policy
  source: PolicySource
  policyPath: string
  warning: string | null
}

export interface BootstrapOptions {
  policyPath?: string
}

export interface BootstrapDeps {
  /** Injected so tests don't need a real filesystem; production wiring passes loadPolicy from @jamjet/cloud/node. */
  loadPolicy: (path?: string) => Policy
}

/**
 * Decide which policy the --serve-self server should run with.
 *
 * Priority order:
 *   1. If options.policyPath is set OR the underlying loadPolicy resolves a file,
 *      use it (source='file').
 *   2. If loadPolicy throws the "No policy file found" sentinel, fall back to the
 *      built-in DEMO_POLICY (source='demo') and return a stderr-bound warning string.
 *   3. Any other error rethrows (e.g. YAML parse errors on a real file the user supplied).
 *
 * Pure function — no filesystem access, no console output. Caller threads the warning
 * to stderr and the result into ServeSelfContext.
 */
export function bootstrapPolicy(
  options: BootstrapOptions,
  deps: BootstrapDeps,
): BootstrapResult {
  try {
    const policy = deps.loadPolicy(options.policyPath)
    return {
      policy,
      source: 'file',
      policyPath: options.policyPath ?? '(resolved by loadPolicy search)',
      warning: null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No policy file found')) {
      return {
        policy: DEMO_POLICY,
        source: 'demo',
        policyPath: '(built-in demo policy)',
        warning: DEMO_POLICY_WARNING,
      }
    }
    throw err
  }
}
