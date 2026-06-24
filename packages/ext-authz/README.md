# @jamjet/ext-authz

A JamJet Policy Decision Point exposed over the Envoy HTTP external-authorization
contract. Put it behind any Envoy-compatible proxy to allow, block, or hold MCP
tool calls and emit AgentBoundary-family receipts.

## Run

    jamjet-ext-authz --policy ./policy.yaml --port 9191 --audit ./receipts.jsonl

The proxy is configured to call this service for each request. A 200 allows the
call; a 403 blocks it; a 403 with `WWW-Authenticate: insufficient_scope` plus an
`x-jamjet-approval-url` header means the call is held pending human approval.

This is the OSS reference adapter. gRPC ext_authz with `dynamic_metadata` receipt
correlation, and a Rust-native PDP, are follow-ups behind the same wire contract.
