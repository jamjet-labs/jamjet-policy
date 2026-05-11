# @jamjet/cli

## 0.1.0 — 2026-05-11

### Added
- `jamjet audit show` — tail today's audit events across every JamJet adapter (claude-code-hook, mcp-shim, openai-guardrail, Python/TS SDKs) in one chronologically-sorted view. Filter by `--date` and/or `--adapter`.
- `jamjet approve <run-id>` / `jamjet reject <run-id>` — resolve pending tool-call approvals by run id (filesystem-based; integrates with `ApprovalQueue` in `@jamjet/cloud@0.3.0`).
- `jamjet --version` / `jamjet --help`.
