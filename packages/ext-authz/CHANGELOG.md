# Changelog

## 0.1.0

First published release.

- JamJet Policy Decision Point over the Envoy HTTP ext_authz contract: allow (200),
  block (403), hold for approval (403 + `WWW-Authenticate: insufficient_scope` +
  `x-jamjet-approval-url`).
- Async approval bridge: filesystem hold keyed by action hash, single-use consume on
  approval, approve/reject CLI, retry-to-allow.
- AgentBoundary-family receipts (`agentboundary/v0.2-alpha+ext-authz`) minted for every
  decision.
- Fail-closed defaults: unknown policyKind denies, oversized (413) and partial bodies deny.
