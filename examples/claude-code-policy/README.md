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

Then run Claude Code. Any tool call matching `*delete*`, `*drop*`, or `shell.exec` is blocked. For `payments.*`, `filesystem.write`, and `github.merge_pull_request`, Claude Code asks you before the call runs. `slack.send_message` is logged but allowed.
