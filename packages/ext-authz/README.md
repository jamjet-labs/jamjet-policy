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

## Cedar policies

    jamjet-ext-authz --policy ./policy.yaml --cedar ./policies.cedar --cedar-schema ./input.cedarschema

Cedar policies run alongside the YAML rules on both surfaces and the stricter outcome
wins (block, then hold, then allow). See [`@jamjet/cedar`](../cedar) for the schema and
the `@require_approval` annotation. The server refuses to start if the Cedar policies
do not parse and validate. Any Cedar evaluation error blocks the call.

The Cedar principal is `JamJet::Agent::"<id>"`. On the AuthZen surface it is
`subject.id`, with string `subject.properties` as tags and `context.risk` as the risk
label. On the ext_authz surface it is `anonymous` unless you pass
`--principal-header <name>`; only do that when your proxy overwrites that header,
since otherwise any client can claim any identity. `context.approval_status` comes
from the hold store, never from the request, and an approval it unlocks is consumed
on use. When a principal is known, holds are bound to it, so one subject's approval
does not release the same call for another.

This is the OSS reference adapter. gRPC ext_authz with `dynamic_metadata` receipt
correlation, and a Rust-native PDP, are follow-ups behind the same wire contract.
