# Changelog

## 0.1.0

First published release.

- Deterministic detectors: tool-definition drift, tool shadowing, token passthrough,
  first-seen server baseline.
- Trust baseline (`trust.lock`): load, save, approve.
- `evaluateToolsList` / `evaluateCall` evaluation pipeline with
  `decideFromFindings` severity resolution.
- MCP Security Receipts: canonical-JSON SHA-256 hashed, append-only JSONL. The
  canonicalizer handles a `__proto__` own-property key as data (null-prototype build),
  so no two distinct payloads collide to the same hash.
- Config via the `threat` block of a policy file, with safe defaults when absent.
