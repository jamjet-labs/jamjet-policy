# Changelog

## 0.2.0

- OpenID AuthZen Authorization API 1.0 surface on the same PDP: `POST /access/v1/evaluation`
  and `POST /access/v1/evaluations` (batch, all three `evaluations_semantic` options,
  64-item cap). Deny is HTTP 200 with `decision: false`; the `require_approval` hold maps
  to a deny whose `context` carries the approval id, URL, and status, and an approved hold
  permits exactly once. Every decision mints the same AgentBoundary-family receipt as the
  ext_authz path. Non-`/access/*` paths keep the Envoy HTTP ext_authz contract unchanged.

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
