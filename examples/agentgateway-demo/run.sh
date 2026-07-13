#!/usr/bin/env bash
# End-to-end: agentgateway MCP route guarded by the JamJet PDP.
#   1. echo      -> ALLOWED
#   2. get-env   -> BLOCKED by policy
#   3. get-sum   -> PENDING (held for human approval)
#   4. approve, retry get-sum -> ALLOWED (single-use approval consumed)
set -euo pipefail
cd "$(dirname "$0")"

AGENTGATEWAY_BIN="${AGENTGATEWAY_BIN:-agentgateway}"
DEMO_TMP="$(pwd)/.tmp"
rm -rf "$DEMO_TMP" && mkdir -p "$DEMO_TMP"

cleanup() {
  [[ -n "${PDP_PID:-}" ]] && kill "$PDP_PID" 2>/dev/null || true
  [[ -n "${GW_PID:-}" ]] && kill "$GW_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "--- starting JamJet PDP (ext-authz) on :9191"
node ../../packages/ext-authz/dist/bin.js \
  --policy ./policy.yaml \
  --port 9191 \
  --audit "$DEMO_TMP/receipts.jsonl" \
  --holds "$DEMO_TMP/holds" \
  --server-name everything >"$DEMO_TMP/pdp.log" 2>&1 &
PDP_PID=$!

echo "--- starting agentgateway on :3000"
"$AGENTGATEWAY_BIN" -f ./agentgateway.yaml >"$DEMO_TMP/gateway.log" 2>&1 &
GW_PID=$!

for i in $(seq 1 30); do
  curl -sf -o /dev/null -X POST http://localhost:3000/mcp \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"ping"}' 2>/dev/null && break
  sleep 1
done

echo "--- 1) echo -> expect ALLOWED"
node client.mjs echo '{"message":"hello through the gate"}'

echo "--- 2) get-env -> expect BLOCKED"
node client.mjs get-env '{}' || true

echo "--- 3) get-sum -> expect PENDING (held for approval)"
node client.mjs get-sum '{"a":2,"b":3}' || true

RUN_ID="$(ls "$DEMO_TMP/holds" | head -1 | sed 's/\.json$//')"
echo "--- 4) human approves hold $RUN_ID"
node ../../packages/ext-authz/dist/bin.js approve "$RUN_ID" --holds "$DEMO_TMP/holds"

echo "--- 5) retry get-sum -> expect ALLOWED (approval consumed, single-use)"
node client.mjs get-sum '{"a":2,"b":3}'

echo "--- receipts:"
python3 -c "
import json,sys
for line in open('$DEMO_TMP/receipts.jsonl'):
    r=json.loads(line)
    print(' ', r.get('decision'), r.get('action',{}).get('tool'), r.get('receipt_hash','')[:24])
" 2>/dev/null || cat "$DEMO_TMP/receipts.jsonl"

echo "--- done: allow, block, and human-approval all enforced through agentgateway"
