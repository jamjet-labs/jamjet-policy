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
