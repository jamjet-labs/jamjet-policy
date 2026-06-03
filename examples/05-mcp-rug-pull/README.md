# Demo: catching an MCP rug pull

A tool you already approved silently changes its description after approval (a
"rug pull"). JamJet pins the approved definition, detects the change, blocks the
call, and writes a verifiable MCP Security Receipt.

## 1. Build the packages
```bash
pnpm install
pnpm --filter @jamjet/mcp-threat build
pnpm --filter @jamjet/mcp-shim build
```

## 2. Approve the clean server (writes ~/.jamjet/mcp-trust.lock)
For this milestone there is no `jamjet mcp trust approve` CLI yet (follow-on
plan), so seed the baseline from a Node one-liner using the published helpers:
```bash
node --input-type=module -e '
import { loadTrustBaseline, approveServer, saveTrustBaseline, defaultTrustLockPath } from "@jamjet/mcp-threat";
const tools=[{name:"read_file",description:"Read a file from disk.",inputSchema:{type:"object",properties:{path:{type:"string"}}}}];
let b=loadTrustBaseline();
b=approveServer(b,"demo-fs","id:demo-fs",tools,new Date().toISOString());
saveTrustBaseline(defaultTrustLockPath(),b);
console.log("approved demo-fs in",defaultTrustLockPath());
'
```

## 3. Run the shim in front of the DRIFTED server and call the tool
```bash
JJ_DEMO_DRIFT=1 node packages/mcp-shim/dist/bin.js \
  --policy examples/05-mcp-rug-pull/policy.yaml \
  --server-name demo-fs \
  -- node examples/05-mcp-rug-pull/drifting-server.mjs
```
Then send (on stdin) an `initialize`, a `tools/list`, and a `tools/call` for
`read_file`. The shim prints a `JamJet threat: tool_definition_drift ... (BLOCKED)`
line, returns a JSON-RPC policy error for the call, and appends a receipt to
`~/.jamjet/audit/mcp-receipts.jsonl`.

> Exact `bin.js` flags (`--policy`, `--server-name`, `--`) follow the existing
> shim CLI in `packages/mcp-shim/src/bin.ts`; adjust to match that file.

## 4. Inspect the receipt
```bash
tail -n 1 ~/.jamjet/audit/mcp-receipts.jsonl
```
You will see `"finding":"tool_definition_drift"`, the `baseline_hash` and
`observed_hash`, the decision `BLOCKED`, and a content-addressed `receipt_hash`.
