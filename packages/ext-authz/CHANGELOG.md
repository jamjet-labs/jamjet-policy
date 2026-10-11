# Changelog

## 0.3.0

- Cedar policies: `--cedar <policies.cedar>` and `--cedar-schema <input.cedarschema>`
  evaluate Cedar (via `@jamjet/cedar`) alongside the YAML rules on the ext_authz and
  AuthZen surfaces. The stricter outcome wins; a Cedar load failure stops startup and
  a Cedar evaluation error blocks the call.
- AuthZen `subject` now reaches the policy engine: `subject.id` is the Cedar principal,
  string `subject.properties` are its tags, and `context.risk` is the risk label.
- Holds are bound to the principal when one is known (AuthZen subject, or the
  `--principal-header` header), so an approval for one subject cannot release the same
  call for another. Holds created by 0.2.0 for AuthZen requests are not found by 0.3.0
  and must be re-requested.
- `context.approval_status` is read from the hold store. An approval that a Cedar
  policy permits on is consumed, like any other approval.
- With Cedar loaded, the ext_authz server name comes from `--server-name` or an
  operator-named `--server-header` (normalized), never from `Host` or
  `x-jamjet-server`, so a client cannot pick the `JamJet::Server` its call is judged in.
- AuthZen with Cedar: number and boolean claims become string tags, array or object
  claims are a 400, and `resource.id` must name the evaluated tool.
- Holds bind the principal's kind, claims, and risk as well as its id, and the hold
  record stores them for the approver.
- A request is allowed on an approval only if it consumed it (single unlink), so two
  replicas sharing a hold directory cannot both spend one approval.
- `handleAuthz` (no hold store) now refuses a call that needs approval instead of
  passing it.

## 0.2.0

- OpenID AuthZen Authorization API 1.0 surface on the same PDP: `POST /access/v1/evaluation`
  and `POST /access/v1/evaluations` (batch, all three `evaluations_semantic` options,
  64-item cap). Deny is HTTP 200 with `decision: false`; the `require_approval` hold maps
  to a deny whose `context` carries the approval id, URL, and status, and an approved hold
  permits exactly once. Every decision mints the same AgentBoundary-family receipt as the
  ext_authz path. Non-`/access/*` paths keep the Envoy HTTP ext_authz contract unchanged.
- Conformance: an empty or absent `evaluations` array falls back to a single evaluation;
  a block deny reason is carried in `context.reason`; a malformed batch item is a 400 for
  the whole batch before any side effect; non-POST methods return 405.
- Hardening: `__proto__`/`constructor`/`prototype` keys in tool arguments are rejected
  (400); any `/access`-family path is routed case-insensitively so it cannot fall through
  to the ext_authz passthrough.

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
