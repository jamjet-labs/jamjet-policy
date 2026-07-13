# @jamjet/ext-authz

A JamJet Policy Decision Point exposed over the Envoy HTTP external-authorization
contract. Put it behind any Envoy-compatible proxy to allow, block, or hold MCP
tool calls and emit AgentBoundary-family receipts.

## Run

    jamjet-ext-authz --policy ./policy.yaml --port 9191 --audit ./receipts.jsonl

The proxy is configured to call this service for each request. A 200 allows the
call; a 403 blocks it; a 403 with `WWW-Authenticate: insufficient_scope` plus an
`x-jamjet-approval-url` header means the call is held pending human approval.

## AuthZen PDP surface

The same server is an OpenID AuthZen 1.0 PDP. `POST /access/v1/evaluation` takes the
standard `subject` / `action` / `resource` request; `action.name` is the tool,
`resource.properties.arguments` (object) enters the action hash, and
`resource.properties.server` names the MCP target. A deny is HTTP 200 with
`decision: false`. A `require_approval` rule answers with the approval id, URL, and
status in `context`, and an approved hold permits exactly once. Batch evaluation is
`POST /access/v1/evaluations` with all three `evaluations_semantic` options (64-item
cap). Paths outside `/access/*` keep the Envoy HTTP ext_authz contract.

This is the OSS reference adapter. gRPC ext_authz with `dynamic_metadata` receipt
correlation, and a Rust-native PDP, are follow-ups behind the same wire contract.
