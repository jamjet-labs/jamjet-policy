# @jamjet/mcp-threat

Deterministic threat controls for MCP traffic: tool-definition drift, tool shadowing,
token passthrough, and a local trust baseline, with a signed-hash MCP Security Receipt
for every decision. Constraint, not classification: every detector is a pure function
over tool definitions and call context, so the same input always produces the same
finding and the same decision.

Used by [@jamjet/mcp-shim](https://www.npmjs.com/package/@jamjet/mcp-shim) and
[@jamjet/ext-authz](https://www.npmjs.com/package/@jamjet/ext-authz). No network calls,
no model calls, no telemetry.

## Install

    npm install @jamjet/mcp-threat

## What it detects

| Detector | Risk it constrains |
|---|---|
| `detectDrift` | A server changed a tool's definition after you trusted it (rug pull) |
| `detectShadowing` | A tool name impersonates or collides with one from another server |
| `detectTokenPassthrough` | Tool arguments smuggle bearer tokens or JWTs to a third party |
| first-seen baseline | Calls to servers you have never approved |

## Usage

Evaluate a `tools/list` against your trust baseline, then gate each `tools/call`:

```ts
import {
  loadTrustBaseline, loadThreatConfig,
  evaluateToolsList, evaluateCall,
  decideFromFindings, buildMcpSecurityReceipt, appendReceipt,
} from '@jamjet/mcp-threat'

const baseline = loadTrustBaseline()          // ~/.jamjet/mcp-trust.lock by default
const config = loadThreatConfig()

const listEval = evaluateToolsList(server, advertisedTools, baseline, config)

const callEval = evaluateCall({
  server,
  tool,
  args,
  serverUnverified: listEval.serverUnverified,
  flagged: listEval.flagged,
  config,
})

const { decision, finding } = decideFromFindings(callEval.findings, config)
if (decision === 'BLOCKED' && finding) {
  appendReceipt(receiptPath, buildMcpSecurityReceipt(finding, decision, 'tools/call', new Date().toISOString()))
  // refuse the call
}
```

Approve a server into the baseline after review:

```ts
import { approveServer, loadTrustBaseline, saveTrustBaseline } from '@jamjet/mcp-threat'
```

## Receipts

`buildMcpSecurityReceipt` mints a canonical-JSON, SHA-256 hashed record of the finding
and the decision. Receipts are append-only JSONL and are AgentBoundary-family artifacts:
the hash covers the full receipt body, so any later edit is detectable.

## Configuration

`loadThreatConfig(policyPath)` reads the `threat` block of a policy file (for example
`~/.jamjet/policy.yaml`); called with no path, or on any parse error, it returns the safe
defaults in `THREAT_DEFAULTS`. Each detector maps to one knob: `on_first_seen`,
`on_definition_drift`, `on_tool_shadow`, `on_token_passthrough`. See the
[jamjet-policy](https://github.com/jamjet-labs/jamjet-policy) repo for the portable
policy schema and the conformance suite.

## License

Apache-2.0
