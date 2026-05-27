# @jamjet/mcp-shim

**JamJet policy + audit + approval as an MCP stdio interceptor.** Drop-in between any MCP client (Claude Desktop, Cursor, OpenAI Agents SDK with MCP, custom) and any MCP server. One policy file, every `tools/call` governed.

## Install + wire in Claude Desktop

In `claude_desktop_config.json` (or `~/.config/claude-code/...`):

```jsonc
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y", "@jamjet/mcp-shim",
        "--policy", "~/.jamjet/policy.yaml",
        "--server", "postgres",
        "--",
        "postgres-mcp", "--db", "postgresql://localhost/mydb"
      ]
    }
  }
}
```

Same shape works for Cursor, OpenAI Agents SDK MCP clients, any stdio-launched MCP server.

## See it in 60 seconds

```bash
mkdir -p ~/.jamjet
cat > ~/.jamjet/policy.yaml <<'EOF'
version: 1
rules:
  - { match: "*delete*", action: block }
  - { match: "*drop*", action: block }
  - { match: "shell.exec", action: block }
EOF
```

Restart Claude Desktop. Any `tools/call` matching `*delete*` from any MCP tool gets a JSON-RPC policy error back to the client — and the real MCP server never sees the request.

## What you get

- **Block** unsafe MCP tools at the wire — before the real MCP server is invoked
- **Approve** risky tools via `jamjet approve <run-id>` *(approval flow lands with `@jamjet/cli` in v0.2)*
- **Audit JSONL** at `~/.jamjet/audit/<YYYY-MM-DD>/mcp-shim.jsonl`

## `--serve-self`: run the policy primitives as their own MCP server

Same binary, no downstream server required:

```bash
npx -y @jamjet/mcp-shim --serve-self --policy ~/.jamjet/policy.yaml
```

Or wired into Claude Desktop / Cursor / any MCP client as a regular server:

```jsonc
{
  "mcpServers": {
    "jamjet-policy": {
      "command": "npx",
      "args": ["-y", "@jamjet/mcp-shim", "--serve-self", "--policy", "~/.jamjet/policy.yaml"]
    }
  }
}
```

Three read-only policy tools become available to the agent:

| Tool | What it does |
|---|---|
| `policy_evaluate` | Dry-run a candidate tool name against the policy; return decision (`allow` / `block` / `require_approval` / `audit`) + matched glob pattern |
| `policy_list_rules` | List every rule in the loaded policy, in declaration order, with action + pattern |
| `policy_load_info` | Report the path of the loaded policy file, rules count, and schema version |

Useful when the agent itself needs to *reason about* the policy ("is `fs.delete_file` allowed before I propose it?"), and a clean alternative to the interceptor pattern when there is no downstream MCP server to wrap.

## Same policy, other places

The same `policy.yaml` is consumed by:

- **Claude Code PreToolUse hook** via [`@jamjet/claude-code-hook`](https://npm.im/@jamjet/claude-code-hook)
- **OpenAI Agents SDK guardrail** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail) *(coming next)*
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

Write the safety policy once. Run it everywhere your agents can act.

## License

Apache-2.0
