# Postgres MCP server policy

Drop this `policy.yaml` into `~/.jamjet/` and update your Claude Desktop / Cursor config to route the Postgres MCP server through `@jamjet/mcp-shim`:

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

Any destructive call is blocked at the wire. Reads pass through unchanged. Writes pause for approval.
