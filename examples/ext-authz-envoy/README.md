# ext_authz PDP proof (Envoy)

Proves a JamJet PDP enforces policy on MCP tools/call through a real Envoy proxy
and mints a receipt per decision.

1. Build the PDP: `pnpm --filter @jamjet/ext-authz build`
2. `bash examples/ext-authz-envoy/run.sh` and follow the printed docker + curl steps.
3. Expect: `search` -> 200, `delete_user` -> 403, two receipts in `receipts.jsonl`
   whose `receipt_hash` values verify with the AgentBoundary hashing tool.

agentgateway follow-up: agentgateway's `extAuthz` targets the Envoy ext_authz
*gRPC* contract first; once the gRPC adapter (separate plan) lands, swap the proxy
from Envoy to agentgateway with no change to policy or receipts.

## Approval bridge (M2)

1. Add a held rule to policy.yaml:
   ```yaml
   rules:
     - match: "payments.*"
       action: require_approval
   ```
2. `curl` a `payments.transfer` tools/call -> expect 403 with `WWW-Authenticate: insufficient_scope`
   and an `x-jamjet-approval-id`.
3. Approve out of band: `node packages/ext-authz/dist/bin.js approve <runId>`.
4. Retry the same `curl` -> expect 200, and a receipt with `policy.decision = ALLOWED`
   plus an `approval` block chaining the run id.
