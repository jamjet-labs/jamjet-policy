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

## MCP protocol versions

The shim governs messages by parsing them, so it only vouches for protocol versions it knows:

| Era | Versions | How the version is carried |
|---|---|---|
| Modern | `2026-07-28` | `params._meta["io.modelcontextprotocol/protocolVersion"]` on every request, no `initialize` |
| Legacy | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` | negotiated once by `initialize` |

An unknown version is never forwarded silently. By default a request that declares one gets `UnsupportedProtocolVersionError` (`-32022`) with the list of versions the shim supports, an `initialize` answer that negotiates one is replaced with an error, and `server/discover` results are narrowed to versions the shim can govern. Set `mcp.protocol.unknown_versions: pass` to forward them with a stderr warning instead; `tools/call` is still policy-checked by name.

Other 2026-07-28 behaviour:

- Server-initiated requests are refused once the client has spoken 2026-07-28 (the spec forbids them on stdio and replaces them with `input_required` results).
- Policy, pins and audit all use the tool name from the JSON-RPC body, which is what the server executes. stdio has no header layer; the same check validates `Mcp-Method` / `Mcp-Name` against the body for HTTP transports and refuses a mismatch with `HeaderMismatch` (`-32020`).
- The shim re-serialises every message it forwards, so a line with a repeated `"name"` key reaches the server with the one name the policy evaluated.
- JSON-RPC batches and a `tools/call` whose `name` is not a string are refused, never forwarded ungoverned. So is a request with a missing or non-string, non-number `id`.
- Server responses are matched to requests by id type and value (`"3"` does not answer request `3`); a response to no pending request is dropped.
- Keys that differ only by case (`"Name"` next to `"name"`, or `"Method"`) are refused in both directions, because some parsers (Go's `encoding/json`) match keys case-insensitively and would read a different message than the shim.
- Messages nested deeper than 256 levels are refused before any recursive code sees them.

## Tool-definition pinning

A tool's definition is what the model reads: `name`, `title`, `description`, `inputSchema`, `outputSchema` and `annotations`. The shim hashes a canonical form of those fields and compares it with a pin. A server that changes a definition after it was pinned (a rug pull) has that tool withheld from `tools/list`, and every call to it is refused until the new hash is approved.

- `tofu` (default): pin each tool the first time the shim sees it.
- `allowlist`: only tools already in the pin file are served. The shim never writes the file.
- `off`: no pinning.

Pins live in `~/.jamjet/mcp-tool-pins.json`, keyed by `--server` name, so give each wrapped server its own `--server`. A 2026-07-28 client may reuse a cached tool list and call a tool without listing it first; the shim then fetches `tools/list` itself before forwarding the call, and refuses the call if the server does not answer within `prefetch_timeout_ms` or does not advertise the tool.

A blocked call returns JSON-RPC error `-32000` with a decision record in `error.data.jamjet`:

```json
{
  "decision": "BLOCKED",
  "reason": "tool_definition_changed",
  "server": "fs",
  "tool": "read_file",
  "pinned_hash": "sha256:...",
  "observed_hash": "sha256:...",
  "pins_file": "/home/me/.jamjet/mcp-tool-pins.json",
  "approve": "jamjet-mcp-shim pins approve --server 'fs' --tool 'read_file' --hash sha256:... --pins '/home/me/.jamjet/mcp-tool-pins.json'"
}
```

The same block is written to the audit log (`rule: pin:<reason>`) and, for a changed or unpinned tool, to `mcp-receipts.jsonl`. Review the new definition, then run the `approve` command; the next call is served without restarting. A call that waited for human approval is checked against its pin again before it is forwarded. `jamjet-mcp-shim pins list` prints the pin file.

Definitions are also scanned for invisible and control characters (zero-width characters, bidi controls, the Unicode TAG block, variation selectors outside a single emoji presentation selector, control characters other than tab, newline and carriage return). These are blocked by default; `mcp.invisible_unicode: warn` forwards the tool and logs instead. Other reasons a tool is blocked: `tool_not_pinned` (allowlist, or past the limit of 500 first-sight pins per process), `ambiguous_definition` (a field name that differs from a pinned field only by case), `definition_too_deep` (nested deeper than 64 levels), `duplicate_tool_definition` (same name advertised twice with different definitions), `tool_not_listed`, `pin_file_unreadable` (a malformed pin file blocks rather than reading as empty).

Pinning covers the advertised definition, not the code that runs behind it.

## Deprecated MCP features

MCP 2026-07-28 deprecates Roots, Sampling and Logging (SEP-2577). They keep working for at least twelve months, so the shim does not break them by default:

| Feature | Default | Why |
|---|---|---|
| Sampling | `warn` on every request | the server asks the client's model to generate, possibly with tools; it is the one deprecated feature that lets a server drive the model |
| Roots | `warn` once per process | exposes client filesystem roots to the server |
| Logging | `pass` | informational server output; a warning per log line would be noise |

`block` answers a server request with an error, refuses a client request (`logging/setLevel`), drops a notification, and refuses an `input_required` result that asks for the feature.

## Configuration

All settings are optional and live in an `mcp:` block of the same `policy.yaml`. An invalid value stops the shim at startup rather than falling back to a default.

```yaml
mcp:
  protocol:
    unknown_versions: refuse      # refuse | pass
  pinning:
    mode: tofu                    # tofu | allowlist | off
    file: ~/.jamjet/mcp-tool-pins.json   # or --pins <file>, or JAMJET_TOOL_PINS
    prefetch_timeout_ms: 5000
  invisible_unicode: block        # block | warn
  deprecated:
    sampling: warn                # pass | warn | block
    roots: warn
    logging: pass
```

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

If `--policy` is omitted and no `policy.yaml` is discovered (cwd, `~/.jamjet/`, or the `JAMJET_POLICY_FILE` env var), the server starts with a built-in **demo policy** (`*delete*` → block, `*drop*` → block, `*destructive*` / `payments.*` → require_approval) and writes a one-line warning to stderr telling you how to bind real rules. `policy_load_info` reports `policy_source: "demo"` so calling clients can detect they're talking to the fallback.

## Same policy, other places

The same `policy.yaml` is consumed by:

- **Claude Code PreToolUse hook** via [`@jamjet/claude-code-hook`](https://npm.im/@jamjet/claude-code-hook)
- **OpenAI Agents SDK guardrail** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail) *(coming next)*
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

Write the safety policy once. Run it everywhere your agents can act.

## License

Apache-2.0
