# Claude Code policy example

Drop this `policy.yaml` into your `~/.jamjet/` and reference it from `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "jamjet-hook --policy ~/.jamjet/policy.yaml" }]
      }
    ]
  }
}
```

Then run Claude Code. Any tool whose name contains `delete` or `drop` is blocked, which covers MCP tools such as `mcp__postgres__delete_rows`. `Bash`, `Write` and GitHub's `merge_pull_request` ask you first. `WebFetch` calls are logged and allowed. Rules match the tool name only, not its arguments.
