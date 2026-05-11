# Claude Code policy example

Drop this `policy.yaml` into your `~/.jamjet/` and reference it from `~/.config/claude-code/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "command": "jamjet-hook --policy ~/.jamjet/policy.yaml" }]
  }
}
```

Then run Claude Code. Any tool call matching `*delete*`, `*drop*`, or `shell.exec` is blocked. `payments.*`, `filesystem.write`, and `github.merge_pull_request` pause (and currently surface as block + audit). `slack.send_message` is logged but allowed.
