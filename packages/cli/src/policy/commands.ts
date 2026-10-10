import { PolicyEvaluator, type PolicyDecision } from '@jamjet/cloud'
import { loadPolicy } from '@jamjet/cloud/node'
import {
  loadCedarPoliciesFromFiles,
  combineDecisions,
  CedarLoadError,
  type ApprovalStatus,
  type CedarDecision,
  type CedarPolicySet,
} from '@jamjet/cedar'

export interface CommandResult {
  exitCode: number
  out: string
  err: string
}

export interface PolicyFileOptions {
  /** YAML policy file. Only read when given; no cwd or home lookup. */
  policy?: string
  cedar?: string
  cedarSchema?: string
}

function result(exitCode: number, out: string[], err: string[] = []): CommandResult {
  return { exitCode, out: out.length ? out.join('\n') + '\n' : '', err: err.length ? err.join('\n') + '\n' : '' }
}

function loadYaml(path: string): PolicyEvaluator {
  const policy = loadPolicy(path)
  const evaluator = new PolicyEvaluator()
  for (const rule of policy.rules) evaluator.add(rule.action, rule.match)
  return evaluator
}

function loadErrorLines(e: unknown): string[] {
  if (e instanceof CedarLoadError) return ['cedar: invalid', ...e.problems.map((p) => `  - ${p}`)]
  return [`error: ${(e as Error)?.message ?? String(e)}`]
}

/** jamjet policy validate [--policy policy.yaml] [--cedar policies.cedar [--cedar-schema input.cedarschema]] */
export function policyValidate(opts: PolicyFileOptions): CommandResult {
  if (!opts.policy && !opts.cedar) {
    return result(64, [], ['Usage: jamjet policy validate [--policy <policy.yaml>] [--cedar <policies.cedar> [--cedar-schema <input.cedarschema>]]'])
  }
  if (opts.cedarSchema && !opts.cedar) return result(64, [], ['--cedar-schema needs --cedar'])
  const out: string[] = []
  const err: string[] = []
  let failed = false
  if (opts.policy) {
    try {
      const p = loadPolicy(opts.policy)
      out.push(`yaml: ${p.rules.length} rules valid (${opts.policy})`)
    } catch (e) {
      failed = true
      err.push(`yaml: invalid (${opts.policy}): ${(e as Error).message}`)
    }
  }
  if (opts.cedar) {
    try {
      const set = loadCedarPoliciesFromFiles(opts.cedar, opts.cedarSchema)
      out.push(`cedar: ${set.policyIds.length} policies valid (${opts.cedar})`)
      for (const id of set.policyIds) out.push(`  - ${id}${set.approvalPolicyIds.includes(id) ? ' (require_approval)' : ''}`)
      for (const w of set.warnings) out.push(`warning: ${w}`)
    } catch (e) {
      failed = true
      err.push(...loadErrorLines(e))
    }
  }
  return result(failed ? 1 : 0, out, err)
}

export interface ExplainOptions extends PolicyFileOptions {
  tool?: string
  server?: string
  /** JSON object of tool arguments. */
  args?: string
  agent?: string
  /** key=value principal tags. */
  tags?: string[]
  risk?: string
  approvalStatus?: string
  json?: boolean
}

const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['none', 'pending', 'approved', 'rejected']

function describe(d: PolicyDecision): string {
  return d.pattern === null ? `${d.policyKind} (no rule matched)` : `${d.policyKind} (rule '${d.pattern}')`
}

/** jamjet policy explain --tool <name> [...]: show what each engine decides and what wins. */
export function policyExplain(opts: ExplainOptions): CommandResult {
  if (!opts.tool) return result(64, [], ['Usage: jamjet policy explain --tool <name> [--server <name>] [--args <json>] [--agent <id>] [--tag k=v] [--risk <label>] [--approval-status none|pending|approved|rejected] [--policy <policy.yaml>] [--cedar <policies.cedar>] [--cedar-schema <file>] [--json]'])
  if (opts.cedarSchema && !opts.cedar) return result(64, [], ['--cedar-schema needs --cedar'])

  let args: Record<string, unknown> = {}
  if (opts.args !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(opts.args)
    } catch {
      return result(64, [], ['--args must be a JSON object'])
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result(64, [], ['--args must be a JSON object'])
    args = parsed as Record<string, unknown>
  }
  const tags: Record<string, string> = {}
  for (const t of opts.tags ?? []) {
    const i = t.indexOf('=')
    if (i <= 0) return result(64, [], [`--tag must be key=value, got '${t}'`])
    tags[t.slice(0, i)] = t.slice(i + 1)
  }
  const approvalStatus = (opts.approvalStatus ?? 'none') as ApprovalStatus
  if (!APPROVAL_STATUSES.includes(approvalStatus)) {
    return result(64, [], [`--approval-status must be one of ${APPROVAL_STATUSES.join(', ')}`])
  }

  let yaml: PolicyDecision | null = null
  let cedarSet: CedarPolicySet | null = null
  try {
    if (opts.policy) yaml = loadYaml(opts.policy).evaluate(opts.tool)
    if (opts.cedar) cedarSet = loadCedarPoliciesFromFiles(opts.cedar, opts.cedarSchema)
  } catch (e) {
    return result(1, [], loadErrorLines(e))
  }

  const server = opts.server ?? 'mcp'
  const agent = opts.agent ?? 'anonymous'
  const cedar: CedarDecision | null = cedarSet
    ? cedarSet.evaluate({
        server,
        tool: opts.tool,
        args,
        principal: { id: agent, tags },
        ...(opts.risk !== undefined ? { risk: opts.risk } : {}),
        approvalStatus,
      })
    : null
  // With no YAML file the YAML engine contributes its no-match default (allow), which
  // is what an adapter with an empty rule list would do.
  const yamlDecision: PolicyDecision = yaml ?? { blocked: false, policyKind: 'allow', pattern: null, toolName: opts.tool }
  const combined = combineDecisions(yamlDecision, cedar)

  if (opts.json) {
    return result(0, [JSON.stringify({ request: { server, tool: opts.tool, agent, tags, risk: opts.risk ?? 'unknown', approvalStatus, args }, yaml, cedar, result: combined }, null, 2)])
  }
  const out = [
    `tool call: ${server}/${opts.tool} as JamJet::Agent::"${agent}"`,
    `yaml:   ${yaml ? describe(yaml) : 'not loaded (pass --policy)'}`,
    `cedar:  ${cedar ? `${cedar.policyKind} (${cedar.reason})` : 'not loaded (pass --cedar)'}`,
    `result: ${combined.policyKind} (from ${combined.source})`,
  ]
  return result(0, out)
}
