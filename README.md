# JamJet Policy

**The portable policy layer for AI agent actions.**

One policy file. One audit trail. Across hooks, guardrails, MCP gateways, SDKs, and custom runtimes.

## Packages

- [`@jamjet/claude-code-hook`](packages/claude-code-hook) — JamJet policy as a Claude Code PreToolUse hook
- [`@jamjet/openai-guardrail`](packages/openai-guardrail) — JamJet policy as an OpenAI Agents SDK guardrail
- [`@jamjet/mcp-shim`](packages/mcp-shim) — JamJet policy as an MCP stdio interceptor
- [`@jamjet/cli`](packages/cli) — Unified `audit show` + `approve` across all adapters

All four adapters share a single `policy.yaml` format and a single audit JSONL schema.

See [conformance/](conformance/) for the spec these adapters all satisfy.
