import { readFileSync } from 'node:fs'
import * as cedar from '@cedar-policy/cedar-wasm/nodejs'
import { CORE_SCHEMA, DEFAULT_INPUT_SCHEMA } from './schema.js'
import { CedarPolicySet, type InputType } from './evaluate.js'

/** Thrown when a Cedar policy set or input schema cannot be loaded. Never caught silently. */
export class CedarLoadError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Cedar policy load failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'CedarLoadError'
    this.problems = problems
  }
}

export interface CedarLoadOptions {
  /** Cedar policy text (one or more static policies). */
  policies: string
  /**
   * A schema fragment that declares `namespace JamJet::Input { type ToolInput = {...}; }`.
   * Defaults to an empty ToolInput, which hides every tool argument from policies.
   */
  inputSchema?: string
}

/** The annotation that turns a satisfied permit into a hold for human approval. */
export const REQUIRE_APPROVAL_ANNOTATION = 'require_approval'

const INPUT_NAMESPACE = 'JamJet::Input'
const CORE_NAMESPACE = 'JamJet'
const PRIMITIVES = new Set(['String', 'Long', 'Boolean', 'Bool'])

type JsonType = { type: string; [k: string]: unknown }

function messages(errs: Array<{ message: string }> | undefined): string[] {
  return (errs ?? []).map((e) => e.message)
}

// Resolve a schema type to the subset tool arguments may use: String, Long, Boolean,
// Set and Record (common types inlined). Entity and extension types are refused, so a
// tool argument can never be read as an entity reference or an extension value.
function resolveType(t: JsonType, commonTypes: Record<string, JsonType>, path: string, depth = 0): InputType {
  if (depth > 32) throw new CedarLoadError([`input schema: type nesting too deep at ${path}`])
  if (t.type === 'EntityOrCommon') return resolveType({ type: String(t.name) }, commonTypes, path, depth + 1)
  if (PRIMITIVES.has(t.type)) return { kind: 'primitive' }
  if (t.type === 'Set') return { kind: 'set', element: resolveType(t.element as JsonType, commonTypes, `${path}[]`, depth + 1) }
  if (t.type === 'Record') {
    const attrs = (t.attributes ?? {}) as Record<string, JsonType>
    const out: Record<string, InputType> = {}
    for (const [name, at] of Object.entries(attrs)) out[name] = resolveType(at, commonTypes, `${path}.${name}`, depth + 1)
    if (t.additionalAttributes === true) {
      throw new CedarLoadError([`input schema: ${path} must not allow additional attributes`])
    }
    return { kind: 'record', attributes: out }
  }
  const local = t.type.startsWith(`${INPUT_NAMESPACE}::`) ? t.type.slice(INPUT_NAMESPACE.length + 2) : t.type
  const common = Object.prototype.hasOwnProperty.call(commonTypes, local) ? commonTypes[local] : undefined
  if (common) return resolveType(common, commonTypes, path, depth + 1)
  throw new CedarLoadError([
    `input schema: ${path} has type '${t.type}'; tool arguments may only use String, Long, Boolean, Set and Record`,
  ])
}

function loadInputType(schemaText: string): InputType {
  const answer = cedar.schemaToJsonWithResolvedTypes(schemaText)
  if (answer.type !== 'success') throw new CedarLoadError(messages(answer.errors).map((m) => `schema: ${m}`))
  const namespaces = Object.keys(answer.json)
  const extra = namespaces.filter((n) => n !== CORE_NAMESPACE && n !== INPUT_NAMESPACE)
  if (extra.length > 0) {
    throw new CedarLoadError([`input schema may only declare namespace ${INPUT_NAMESPACE}; found ${extra.map((n) => `'${n}'`).join(', ')}`])
  }
  const ns = answer.json[INPUT_NAMESPACE]
  if (!ns) throw new CedarLoadError([`input schema must declare namespace ${INPUT_NAMESPACE}`])
  // Actions or entity types here could be named by a policy that validates but never
  // matches a JamJet request (every request is JamJet::Action::"call_tool"), which would
  // make a forbid silently dead. Only common types are allowed.
  if (Object.keys(ns.entityTypes ?? {}).length > 0 || Object.keys(ns.actions ?? {}).length > 0) {
    throw new CedarLoadError([`input schema may only declare common types (type ... = ...), not entities or actions`])
  }
  const commonTypes = (ns.commonTypes ?? {}) as Record<string, JsonType>
  const toolInput = commonTypes.ToolInput
  // Unreachable in practice (the core schema references ToolInput, so the parser
  // rejects a schema without it first); kept so a parser change cannot skip it.
  if (!toolInput) throw new CedarLoadError([`input schema must declare type ToolInput`])
  const resolved = resolveType(toolInput, commonTypes, 'ToolInput')
  if (resolved.kind !== 'record') throw new CedarLoadError([`input schema: ToolInput must be a record type`])
  return resolved
}

interface ParsedPolicy {
  id: string
  text: string
  effect: 'permit' | 'forbid'
  requiresApproval: boolean
}

function parsePolicies(text: string): ParsedPolicy[] {
  const parts = cedar.policySetTextToParts(text)
  if (parts.type !== 'success') throw new CedarLoadError(messages(parts.errors).map((m) => `policy parse: ${m}`))
  if (parts.policy_templates.length > 0) {
    throw new CedarLoadError([`policy templates are not supported (found ${parts.policy_templates.length}); write static policies`])
  }
  const out: ParsedPolicy[] = []
  const seen = new Set<string>()
  const problems: string[] = []
  parts.policies.forEach((policyText, i) => {
    const json = cedar.policyToJson(policyText)
    if (json.type !== 'success') {
      problems.push(...messages(json.errors).map((m) => `policy ${i}: ${m}`))
      return
    }
    const annotations = json.json.annotations ?? {}
    const id = Object.prototype.hasOwnProperty.call(annotations, 'id') && annotations.id ? String(annotations.id) : `policy${i}`
    if (seen.has(id)) problems.push(`duplicate policy id '${id}'`)
    seen.add(id)
    const effect = json.json.effect
    let requiresApproval = false
    if (Object.prototype.hasOwnProperty.call(annotations, REQUIRE_APPROVAL_ANNOTATION)) {
      const v = annotations[REQUIRE_APPROVAL_ANNOTATION]
      if (v !== null && v !== undefined && v !== '' && v !== 'true') {
        problems.push(`policy '${id}': @${REQUIRE_APPROVAL_ANNOTATION} takes no value or "true", got "${String(v)}"`)
      } else if (effect !== 'permit') {
        problems.push(`policy '${id}': @${REQUIRE_APPROVAL_ANNOTATION} is only valid on a permit policy`)
      } else {
        requiresApproval = true
      }
    }
    out.push({ id, text: policyText, effect, requiresApproval })
  })
  if (problems.length > 0) throw new CedarLoadError(problems)
  return out
}

let loadCounter = 0

/**
 * Parse, check and validate a Cedar policy set against the published JamJet schema.
 * Throws CedarLoadError on any parse error, schema error, validation error or warning:
 * a policy set that is not fully understood is never enforced.
 */
export function loadCedarPolicies(opts: CedarLoadOptions): CedarPolicySet {
  const schemaText = `${CORE_SCHEMA}\n${opts.inputSchema ?? DEFAULT_INPUT_SCHEMA}`
  const inputType = loadInputType(schemaText)

  const policies = parsePolicies(opts.policies)
  const staticPolicies: Record<string, string> = {}
  for (const p of policies) staticPolicies[p.id] = p.text

  const validation = cedar.validate({
    schema: schemaText,
    policies: { staticPolicies },
    validationSettings: { mode: 'strict' },
  })
  if (validation.type !== 'success') throw new CedarLoadError(messages(validation.errors).map((m) => `validation: ${m}`))
  const problems = [
    ...validation.validationErrors.map((e) => `policy '${e.policyId}': ${e.error.message}`),
    // Warnings are fatal too: an "impossible policy" forbid never fires, and a
    // confusable or mixed-script identifier can make a policy read differently
    // from how it evaluates.
    ...validation.validationWarnings.map((e) => `policy '${e.policyId}' (warning): ${e.error.message}`),
  ]
  if (problems.length > 0) throw new CedarLoadError(problems)

  const warnings = messages(validation.otherWarnings)
  if (!policies.some((p) => p.effect === 'permit')) {
    warnings.push('no permit policy: Cedar denies every tool call')
  }

  const key = `jamjet-${process.pid}-${++loadCounter}`
  const ps = cedar.preparsePolicySet(key, { staticPolicies })
  if (ps.type !== 'success') throw new CedarLoadError(messages(ps.errors))
  const ss = cedar.preparseSchema(key, schemaText)
  if (ss.type !== 'success') throw new CedarLoadError(messages(ss.errors))

  return new CedarPolicySet({
    key,
    policyIds: policies.map((p) => p.id),
    approvalIds: new Set(policies.filter((p) => p.requiresApproval).map((p) => p.id)),
    inputType,
    warnings,
  })
}

/** Read a Cedar policy file and an optional JamJet::Input schema file, then load them. */
export function loadCedarPoliciesFromFiles(policyPath: string, inputSchemaPath?: string): CedarPolicySet {
  const policies = readFileSync(policyPath, 'utf-8')
  const inputSchema = inputSchemaPath ? readFileSync(inputSchemaPath, 'utf-8') : undefined
  return loadCedarPolicies({ policies, inputSchema })
}
