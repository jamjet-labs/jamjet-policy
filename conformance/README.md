# Conformance suite

Every JamJet adapter — Claude Code hook, MCP shim, OpenAI guardrail, Python SDK, TS SDK — MUST:

1. Produce the decision in `policy-decisions.yaml` for the given policy + tool input
2. Emit audit events conforming to `audit-event-shape.json` (JSON Schema)

This is the load-bearing contract that makes "one policy, one audit trail" true.

## Running

Each adapter ships a test runner that loads `policy-decisions.yaml` and replays each case. Adapter CI fails if any case mismatches.

## Adding a case

Append to `cases:` in `policy-decisions.yaml`. Re-run every adapter's conformance test. If any adapter mismatches, either the suite is wrong or the adapter is — fix one of them and document the resolution in the commit message.
