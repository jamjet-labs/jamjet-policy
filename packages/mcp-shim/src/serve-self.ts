import type { Policy, PolicyEvaluator } from '@jamjet/cloud'
import { JsonRpcStream, type JsonRpcRequest, type JsonRpcResponse } from './jsonrpc.js'

export const POLICY_TOOL_NAMES = ['policy_evaluate', 'policy_list_rules', 'policy_load_info'] as const

export interface ServeSelfContext {
  policy: Policy
  evaluator: PolicyEvaluator
  policyPath: string
}

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, { type: string; description: string; additionalProperties?: boolean }>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

export function buildServeSelfTools(): ToolDefinition[] {
  return [
    {
      name: 'policy_evaluate',
      description:
        'Evaluate the currently loaded JamJet policy against a candidate MCP tool name. Returns the matched rule, the decision (allow / block / require_approval / audit), and the matched glob pattern. Use this to dry-run a tool call before issuing it, or to explain why a previous call was blocked. Read-only and side-effect free — does not write to the audit log.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: {
            type: 'string',
            description: 'Fully-qualified MCP tool name, e.g. "filesystem.delete_file" or "github.merge_pull_request". Pattern matching follows the same glob rules as the policy file (`*` matches any chars except `.`, `**` matches across `.`).',
          },
          arguments: {
            type: 'object',
            description: 'Optional tool-call arguments. Recorded for audit-trail symmetry but not used for matching in policy v1 (only the tool name is matched against rule patterns).',
          },
        },
        required: ['tool_name'],
        additionalProperties: false,
      },
    },
    {
      name: 'policy_list_rules',
      description:
        'List every rule in the currently loaded JamJet policy, in declaration order. Each entry includes the rule index, action (allow / block / require_approval / audit), and the glob pattern it matches. Use this to inspect the active policy without reading the YAML file directly, or to verify a rollout placed rules in the expected order. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'policy_load_info',
      description:
        'Report the path to the policy file currently loaded by this server, plus the number of rules it contains and the policy schema version. Use this once at session start to confirm the server has the expected policy attached. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ]
}

const SERVER_INFO = {
  name: 'jamjet-policy',
  version: '0.2.0',
} as const

const PROTOCOL_VERSION = '2024-11-05'

export function handleServeSelfRequest(
  req: JsonRpcRequest,
  ctx: ServeSelfContext,
): JsonRpcResponse {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
          tools: {},
        },
      },
    }
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: buildServeSelfTools() },
    }
  }

  if (req.method === 'tools/call') {
    const name = (req.params?.name as string | undefined) ?? ''
    const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {}
    return dispatchTool(req.id, name, args, ctx)
  }

  return methodNotFound(req.id, req.method)
}

function dispatchTool(
  id: number | string,
  name: string,
  args: Record<string, unknown>,
  ctx: ServeSelfContext,
): JsonRpcResponse {
  switch (name) {
    case 'policy_evaluate':
      return callPolicyEvaluate(id, args, ctx)
    case 'policy_list_rules':
      return callPolicyListRules(id, ctx)
    case 'policy_load_info':
      return callPolicyLoadInfo(id, ctx)
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      }
  }
}

function callPolicyEvaluate(
  id: number | string,
  args: Record<string, unknown>,
  ctx: ServeSelfContext,
): JsonRpcResponse {
  const toolName = args.tool_name
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: 'policy_evaluate requires "tool_name" (non-empty string)' },
    }
  }
  const d = ctx.evaluator.evaluate(toolName)
  const decision = d.policyKind
  const matched_pattern = d.pattern
  const rule_kind = d.pattern ? d.policyKind : null
  const summary = matched_pattern
    ? `${decision}: tool "${toolName}" matched rule "${matched_pattern}" (${decision})`
    : `${decision}: no rule matched "${toolName}" — defaulting to ${decision}`
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        tool_name: toolName,
        decision,
        matched_pattern,
        rule_kind,
        blocked: d.blocked,
      },
    },
  }
}

function callPolicyListRules(id: number | string, ctx: ServeSelfContext): JsonRpcResponse {
  const rules = ctx.policy.rules.map((r, index) => ({
    index,
    action: r.action,
    pattern: r.match,
    ...(r.approval_timeout !== undefined ? { approval_timeout: r.approval_timeout } : {}),
  }))
  const summary = rules.length === 0
    ? 'No rules in the loaded policy.'
    : rules.map((r) => `[${r.index}] ${r.action} ${r.pattern}`).join('\n')
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: summary }],
      structuredContent: { rules },
    },
  }
}

function callPolicyLoadInfo(id: number | string, ctx: ServeSelfContext): JsonRpcResponse {
  const info = {
    policy_path: ctx.policyPath,
    rules_count: ctx.policy.rules.length,
    policy_version: ctx.policy.version,
  }
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        { type: 'text', text: `Policy loaded from ${info.policy_path} — ${info.rules_count} rule(s), schema v${info.policy_version}.` },
      ],
      structuredContent: info,
    },
  }
}

function methodNotFound(id: number | string, method: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  }
}

export interface ServeSelfOptions {
  policyPath?: string
}

/**
 * Run jamjet-mcp-shim as a standalone MCP server exposing the three
 * policy introspection tools. No downstream subprocess is spawned.
 * The server speaks line-delimited JSON-RPC 2.0 over stdio per MCP convention.
 */
export async function runServeSelf(options: ServeSelfOptions): Promise<number> {
  const { loadPolicy } = await import('@jamjet/cloud/node')
  const { PolicyEvaluator } = await import('@jamjet/cloud')

  const policy = loadPolicy(options.policyPath)
  const evaluator = new PolicyEvaluator()
  for (const r of policy.rules) evaluator.add(r.action, r.match)

  const ctx: ServeSelfContext = {
    policy,
    evaluator,
    policyPath: options.policyPath ?? '(built-in defaults)',
  }

  const upstream = new JsonRpcStream()
  upstream.on('message', (msg) => {
    if (!('method' in msg)) return
    const req = msg as JsonRpcRequest
    if (!('id' in req)) {
      // Notification — MCP clients use this for "initialized". Ack silently.
      return
    }
    const response = handleServeSelfRequest(req, ctx)
    process.stdout.write(JsonRpcStream.encode(response))
  })

  process.stdin.on('data', (b: Buffer) => upstream.feed(b))

  return new Promise<number>((resolve) => {
    process.on('SIGTERM', () => resolve(0))
    process.on('SIGINT', () => resolve(0))
    process.stdin.on('end', () => resolve(0))
  })
}
