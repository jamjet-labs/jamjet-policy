# @jamjet/cli

**Unified CLI across every JamJet adapter.** Tail audit events from `claude-code-hook` + `mcp-shim` + `openai-guardrail` + Python/TS SDKs in one view. Approve or reject pending tool calls by run id.

## Install

```bash
npm i -g @jamjet/cli
```

## Commands

```bash
# Tail today's audit events across all adapters
jamjet audit show

# Specific date / adapter filter
jamjet audit show --date 2026-05-11 --adapter mcp-shim

# Approve / reject a pending tool call
jamjet approve run_a1b2c3
jamjet reject  run_a1b2c3
```

Audit events are read from `~/.jamjet/audit/<YYYY-MM-DD>/<adapter>.jsonl`. Pending approvals live in `~/.jamjet/pending/<run-id>.json`.

## License

Apache-2.0
