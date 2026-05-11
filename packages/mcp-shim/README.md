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

## Same policy, other places

The same `policy.yaml` is consumed by:

- **Claude Code PreToolUse hook** via [`@jamjet/claude-code-hook`](https://npm.im/@jamjet/claude-code-hook)
- **OpenAI Agents SDK guardrail** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail) *(coming next)*
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

Write the safety policy once. Run it everywhere your agents can act.

## License

Apache-2.0
