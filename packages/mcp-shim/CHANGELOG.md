# @jamjet/mcp-shim

## 0.1.0 — 2026-05-11

### Added
- Initial release. MCP stdio interceptor: drop-in between any MCP client and any MCP server. Reads JSON-RPC from client, intercepts `tools/call` requests, applies JamJet policy via `@jamjet/cloud`'s `PolicyEvaluator`, forwards or returns a `-32000` JSON-RPC policy error.
- Audit JSONL at `~/.jamjet/audit/<YYYY-MM-DD>/mcp-shim.jsonl`, conformant with the v1 schema.
- Approval flow: `WAITING_FOR_APPROVAL` decisions enqueue a pending approval at `~/.jamjet/pending/<run-id>.json`. Full `jamjet approve <run-id>` UX lands with `@jamjet/cli` in v0.2.
- Loads policy from `--policy <path>`, `JAMJET_POLICY_FILE`, `./policy.yaml`, or `~/.jamjet/policy.yaml`.
- Conformance suite: 31 of 32 shared cases pass (the `mcp-prefix-strip` case is adapter-specific to Claude Code hook and intentionally skipped).
- Integration test against a fake MCP server validates block + allow paths end-to-end.

### Known limitations (v0.1)
- `host` field in audit events defaults to `claude-desktop`. Future versions will infer host from the `initialize` request's client info.
- Approval flow surfaces a stderr message + enqueues the pending file, but in v0.1 the shim returns the policy error to the client immediately if approval times out (5 min default).
