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

Add the hook to `~/.claude/settings.json` (every project) or `.claude/settings.json` (one project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "jamjet-hook --policy ~/.jamjet/policy.yaml"
          }
        ]
      }
    ]
  }
}
```

`"matcher": "*"` sends every tool call, MCP tools included, through the policy. Rules match on the tool name (`Bash`, `Edit`, `WebFetch`, or for MCP tools the name after the `mcp__<server>__` prefix), not on its arguments. A call that no rule matches goes through unchanged and Claude Code's own permission prompts still apply.

On Claude Code 2.1.295 or later, also set `"onFailure": "block"` next to `"command"`. Then a missing binary or a timeout blocks the call too, instead of letting it run.

## See it in 60 seconds

```bash
# Write a policy:
mkdir -p ~/.jamjet
cat > ~/.jamjet/policy.yaml <<'EOF'
version: 1
rules:
  - { match: "*delete*", action: block }
  - { match: "WebFetch", action: require_approval }
EOF

# Test the hook directly:
echo '{"hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"mcp__postgres__delete_rows","tool_input":{}}' | jamjet-hook --policy ~/.jamjet/policy.yaml
echo "exit: $?"
# JamJet policy: BLOCKED (rule: *delete*)
# exit: 2

echo '{"hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"WebFetch","tool_input":{}}' | jamjet-hook --policy ~/.jamjet/policy.yaml
echo "exit: $?"
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"JamJet policy: approval required (rule: WebFetch)"}}
# exit: 0
```

## What the hook returns

| Policy result | Hook output | Claude Code |
|---|---|---|
| `block` | exit 2, reason on stderr | blocks the call and shows Claude the reason |
| `require_approval` | exit 0, `permissionDecision: "ask"` on stdout | asks you before the call runs |
| `require_approval` in `bypassPermissions` mode | exit 2, reason on stderr | blocks the call |
| `allow`, `audit`, or no matching rule | exit 0, no output | normal permission flow |
| any error | exit 2, reason on stderr | blocks the call |

The ask goes through Claude Code's normal permission prompt, in `auto` mode too. `bypassPermissions` skips prompts and nothing documents that a hook's ask survives it, so there the hook blocks. It also blocks in a mode it doesn't know and when the input has no `permission_mode`. Whatever answers your permission prompts answers this one: you in an interactive session, or a `PermissionRequest` hook, a `--permission-prompt-tool` or a mod if you have one. In a `-p` run with none of those, Claude Code denies the call.

Errors include an unreadable or invalid policy, an unknown action such as `blok`, a rule whose `match` is empty or starts with `mcp__` (rules see MCP tools without that prefix, so it could never match), an `audit` block with unknown keys, an unknown flag, and stdin that is not a PreToolUse event. Claude Code treats any exit code other than 0 or 2 as a non-blocking error and runs the tool, so the hook never uses one.

## Which policy file

1. `--policy <path>` (a leading `~/` is expanded)
2. `JAMJET_POLICY_FILE`, or `JAMJET_POLICY` (if both are set to different files, the hook blocks)
3. `~/.jamjet/policy.yaml`

The path must be absolute after `~/` is expanded, and so must `HOME`. It must point at a regular file under 1 MiB. The working directory is never searched and relative paths are refused, so a repository cannot ship a `policy.yaml` that replaces yours. Pass `--policy` in the settings command: it wins over the environment variables, which a project's `.claude/settings.json` can set through its `env` block. A project's settings can still turn every hook off with `disableAllHooks`; only hooks in managed settings hold against that.

## Audit log

Every decision is appended to `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl` (or under `audit.destination` from the policy, which must be absolute after `~/` expansion) before the hook exits. If that write fails, the call is blocked. To let calls through without an audit record, add `--allow-audit-failure` to the command; a `block` decision still blocks.

## How MCP tools are matched

Claude Code surfaces MCP tools as `mcp__<server>__<tool>`. The hook strips the prefix before policy matching, so:

```yaml
rules:
  - { match: "*delete*", action: block }
```

…blocks `mcp__postgres__delete_all_customers` and `mcp__sqlite__delete_rows` alike. Policies remain MCP-server-agnostic.

## Same policy, other places

The same `policy.yaml` is consumed by:

- **MCP stdio traffic** via [`@jamjet/mcp-shim`](https://npm.im/@jamjet/mcp-shim)
- **OpenAI Agents SDK** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail)
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

Write the safety policy once. Run it everywhere your agents can act.

## License

Apache-2.0
