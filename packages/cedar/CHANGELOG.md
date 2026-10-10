# Changelog

## 0.1.0

First release.

- Load Cedar policies and validate them in strict mode against the published JamJet
  agent tool-call schema plus a user `JamJet::Input` argument schema.
- Evaluate per tool call and return the engine's `PolicyDecision` (allow, block,
  require_approval). `@require_approval` on a permit holds the call for approval.
- Fail closed on evaluation errors, request validation errors, and anything the loader
  does not fully understand.
- Load errors for approval annotation near-misses and for `has` tests on undeclared
  arguments. Integers beyond 2^53 block. Preparsed sets use random keys, so two copies
  of the module in one process cannot overwrite each other's policies.
- `combineDecisions` composes YAML rule and Cedar decisions; the stricter outcome wins.
