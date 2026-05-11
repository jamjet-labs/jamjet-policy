# @jamjet/claude-code-hook

## 0.1.0 — 2026-05-11

### Added
- Initial release. Reads Claude Code PreToolUse hook JSON from stdin, applies JamJet policy via `@jamjet/cloud`'s `PolicyEvaluator`, writes audit event to `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl`, exits with appropriate code (0=allow/audit, 2=block/approval).
- Strips `mcp__<server>__` prefix from Claude Code's MCP tool names so policies remain MCP-server-agnostic.
- Loads policy from `--policy <path>`, `JAMJET_POLICY_FILE`, `./policy.yaml`, or `~/.jamjet/policy.yaml` (in that order).
- Conformance suite (32 cases) passes — same suite as `@jamjet/mcp-shim`, `@jamjet/openai-guardrail`, and the JamJet Python/TS SDKs.

### Known limitations (v0.1)
- `require_approval` rules surface as a block + audit event. Full approval flow with `jamjet approve <run-id>` lands in v0.2 (waiting on the `@jamjet/cli` package).
