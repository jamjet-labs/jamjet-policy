# agentgateway + JamJet PDP demo

A real MCP server, fronted by [agentgateway](https://agentgateway.dev), governed by the
JamJet Policy Decision Point. One policy file decides per tool call: allow, block, or hold
for a human. Every decision mints a tamper-evident receipt. No SDK in the agent, no code in
the MCP server: enforcement is a route policy on the gateway.

```
MCP client ──▶ agentgateway :3000 ──▶ everything MCP server (stdio)
                    │
                    │ extAuthz (HTTP, request body included)
                    ▼
            jamjet-ext-authz :9191 ──▶ policy.yaml
                    │                   allow / block / require_approval
                    ▼
            receipts.jsonl (AgentBoundary-family, hash-chained to approvals)
```

## What the run shows

1. `echo` passes: the gateway forwards the tool result.
2. `get-env` is blocked by policy: the client gets a 403 with the receipt hash.
3. `get-sum` matches `require_approval`: the PDP holds the call and answers with
   `WWW-Authenticate: insufficient_scope` plus an approval id. Synchronous proxies cannot
   park a request for a human, so the deny carries everything needed to resume.
4. A human approves: `jamjet-ext-authz approve <run_id>`.
5. The retried `get-sum` is allowed once (the approval is single-use) and the receipt
   records the approval chain.

## Run it

Prerequisites: Node 22+, pnpm, and the agentgateway binary
([releases](https://github.com/agentgateway/agentgateway/releases)).

    pnpm install
    pnpm --filter @jamjet/ext-authz build
    AGENTGATEWAY_BIN=/path/to/agentgateway bash run.sh

If `agentgateway` is already on your PATH, plain `bash run.sh` works.

## Files

- `agentgateway.yaml`: the gateway config. The `extAuthz` policy points at the PDP over
  the Envoy HTTP external-authorization contract with the request body included, and
  injects `x-jamjet-server` so receipts name the MCP target.
- `policy.yaml`: the JamJet portable policy. The same file drives every JamJet adapter.
- `client.mjs`: a minimal Streamable HTTP MCP client used by the runbook.
- `run.sh`: the end-to-end runbook described above.

Verified with agentgateway v1.3.1 and @modelcontextprotocol/server-everything (tool names
`echo`, `get-env`, `get-sum`; older releases used `printEnv` and `add`).
