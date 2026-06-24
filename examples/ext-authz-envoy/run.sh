#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# 1. Start the PDP (built bin) on :9191
node "$HERE/../../packages/ext-authz/dist/bin.js" --policy "$HERE/policy.yaml" --port 9191 --audit "$HERE/receipts.jsonl" &
PDP=$!
trap 'kill $PDP 2>/dev/null || true' EXIT
sleep 1

# 2. Start a stub upstream on :8000 that echoes 200
node -e 'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(8000)' &
UP=$!
trap 'kill $PDP $UP 2>/dev/null || true' EXIT
sleep 1

# 3. Run Envoy (Docker), host-networked so it can reach pdp/upstream by 127.0.0.1.
#    NOTE: in envoy.yaml swap address: pdp/upstream for 127.0.0.1 when using host networking.
echo "Start envoy with: docker run --rm --network host -v $HERE/envoy.yaml:/c.yaml envoyproxy/envoy:v1.31-latest -c /c.yaml"
echo "Then:"
echo "  curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8080/ -d '{\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{}}}'   # expect 200"
echo "  curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8080/ -d '{\"method\":\"tools/call\",\"params\":{\"name\":\"delete_user\",\"arguments\":{}}}'  # expect 403"
echo "  tail -n2 $HERE/receipts.jsonl   # one ALLOWED, one BLOCKED receipt"
wait
