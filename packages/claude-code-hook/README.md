# @jamjet/claude-code-hook

**JamJet policy + audit + approval as a [Claude Code](https://docs.claude.com/code) PreToolUse hook.**

One `policy.yaml`. One audit trail. Works alongside Claude Code's hook system without replacing anything.

## Install

```bash
npm i -g @jamjet/claude-code-hook
# or zero-install:
npx @jamjet/claude-code-hook
```

## Wire it up

In `~/.config/claude-code/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "command": "jamjet-hook --policy ~/.jamjet/policy.yaml" }
    ]
  }
}
```

## See it in 60 seconds

```bash
# Write a policy:
mkdir -p ~/.jamjet
cat > ~/.jamjet/policy.yaml <<'EOF'
version: 1
rules:
  - { match: "*delete*", action: block }
  - { match: "shell.exec", action: block }
  - { match: "payments.*", action: require_approval }
EOF

# Test the hook directly:
echo '{"tool_name":"database.delete_all_customers","tool_input":{}}' | jamjet-hook --policy ~/.jamjet/policy.yaml
echo "exit: $?"
# JamJet policy: BLOCKED (rule: *delete*)
# exit: 2
```

Then wire into Claude Code's `settings.json` (above) and every tool call — including MCP tools — runs through this policy.

## What you get

- **Block** unsafe tools at runtime — before Claude Code invokes them
- **Pause for approval** on risky tools (`require_approval` action; approval flow lands in a near-term release — v0.1 surfaces as a block + audit event)
- **Audit JSONL** at `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl`

## How MCP tools are matched

Claude Code surfaces MCP tools as `mcp__<server>__<tool>`. The hook strips the prefix before policy matching, so:

```yaml
rules:
  - { match: "*delete*", action: block }
```

…blocks both `database.delete_all_customers` (a native tool) **and** `mcp__postgres__delete_all_customers` (an MCP tool). Policies remain MCP-server-agnostic.

## Same policy, other places

The same `policy.yaml` is consumed by:

- **MCP stdio traffic** via [`@jamjet/mcp-shim`](https://npm.im/@jamjet/mcp-shim) *(coming next)*
- **OpenAI Agents SDK** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail) *(coming next)*
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

Write the safety policy once. Run it everywhere your agents can act.

## License

Apache-2.0
