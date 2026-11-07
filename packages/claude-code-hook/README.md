# @jamjet/claude-code-hook

**JamJet policy + audit + approval as a [Claude Code](https://docs.claude.com/code) PreToolUse hook.**

One `policy.yaml`. One audit trail. Works alongside Claude Code's hook system without replacing anything.

## Install

```bash
npm i -g @jamjet/claude-code-hook
```

Install it rather than running it through `npx`: the hook runs before every tool call, and a hook command that downloads code on each call is slow and runs whatever the registry serves at that moment.

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
            "command": "jamjet-hook --policy ~/.jamjet/policy.yaml",
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

`"matcher": "*"` sends every tool call, MCP tools included, through the policy. A call that no rule matches goes through unchanged and Claude Code's own permission prompts still apply.

`"onFailure": "block"` covers what the hook can't: if `jamjet-hook` is missing, `node` can't start it, or it runs past `"timeout"` seconds, Claude Code blocks the call. It needs Claude Code 2.1.295 or later. Older versions don't support it, and there a hook that fails to start or times out lets the call run.

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
| `require_approval` in `plan` or `bypassPermissions` mode | exit 2, reason on stderr | blocks the call |
| `allow`, `audit`, or no matching rule | exit 0, no output | normal permission flow |
| an error inside the hook | exit 2, reason on stderr | blocks the call |
| the hook never runs or never finishes | none | blocks with `onFailure: "block"`; without it, runs the tool |

The ask goes through Claude Code's normal permission prompt, in `auto` mode too. Nothing documents that a hook's ask reaches a person in `plan` or `bypassPermissions` mode, so there the hook blocks. It also blocks in a mode it doesn't know and when the input has no `permission_mode`. Whatever answers your permission prompts answers this one: you in an interactive session, or a `PermissionRequest` hook, a `--permission-prompt-tool` or a mod if you have one. In a `-p` run with none of those, Claude Code denies the call.

Errors inside the hook include an unreadable or invalid policy, an unknown action such as `blok`, an unknown key anywhere in the policy, a pattern no tool name can match, an unknown flag, a `tool_name` Claude Code could not have sent, and stdin that is not a PreToolUse event. Claude Code treats any exit code other than 0 or 2 as a non-blocking error and runs the tool, so the hook never uses one.

## Writing rules

Rules are checked in order and the first match wins. `*` matches any run of characters and `?` matches one; everything else is literal and case-sensitive. Rules match the tool name, not its arguments. Shell commands can run through three built-in tools, `Bash`, `PowerShell` and `Monitor`, so a rule meant for shell commands needs all three.

The hook is strict about the policy, because an ignored line reads as a control that isn't there:

- Only `version`, `rules` and `audit` are allowed at the top level, only `match` and `action` in a rule, and only `destination` and `rotate_daily` under `audit`. `default:` is refused; end the rules with `{ match: "*", action: block }` instead. `budgets` and `approval_timeout` are refused because this hook doesn't enforce them.
- Claude Code tool names are 1 to 128 characters of `A-Z a-z 0-9 _ -`. A pattern with any other character (`Bash(rm *)`, `shell.exec`, a trailing space) or a wrong-case built-in name (`bash`) can never match and is refused.

## How MCP tools are matched

Claude Code names MCP tools `mcp__<server>__<tool>`. Every rule matches against that full name. A rule that blocks, asks or audits also matches the bare `<tool>`, so these work whatever the server is called:

```yaml
rules:
  - { match: "*delete*", action: block }                       # mcp__postgres__delete_rows
  - { match: "merge_pull_request", action: require_approval }   # mcp__github__merge_pull_request
```

An allow rule only matches the full name. Allow MCP tools by server or by full name:

```yaml
rules:
  - { match: "Read", action: allow }            # the built-in Read only
  - { match: "mcp__github__*", action: allow }  # every tool of the github server
  - { match: "mcp__*__query", action: allow }   # query on any server
  - { match: "*", action: block }
```

So a server that names a tool `Read` can't use the allow written for the built-in `Read`.

Server names can contain `__` and can start or end with `_`, so `mcp__a__b__delete_rows` can be read more than one way. When Claude Code sends the server's name (the `mcp_server` field, Claude Code 2.1.274 and later), the hook strips exactly `mcp__<name>__`. Without it, block, ask and audit rules are checked against every possible bare name.

An allow pattern matches the full name as text, so `mcp__github__*` also covers a server named `github__x`, whose tools are `mcp__github__x__<tool>`. The server name comes from your MCP configuration, and a project's `.mcp.json` can name its server anything, so an allow by server name trusts that name. The audit log records the server's `source` (for example `user`, `project` or `plugin`) when Claude Code sends it.

## Which policy file

1. `--policy <path>` (a leading `~/` is expanded)
2. `JAMJET_POLICY_FILE`, or `JAMJET_POLICY` (if both are set to different files, the hook blocks)
3. `~/.jamjet/policy.yaml`

The path must be absolute after `~/` is expanded, and so must `HOME`. It must point at a regular file under 1 MiB. The working directory is never searched and relative paths are refused, so a repository cannot ship a `policy.yaml` that replaces yours. Pass `--policy` in the settings command: it wins over the environment variables, which a project's `.claude/settings.json` can set through its `env` block. A project's settings can still turn every hook off with `disableAllHooks`; only hooks in managed settings hold against that.

## Audit log

Every decision is appended to `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl` (or under `audit.destination`, which must be absolute after `~/` expansion) before the hook exits. New directories are created `0700` and new files `0600`. The log file must be a regular file: a FIFO, a symlink or anything else at that path is refused. The line is written by a short-lived child process that has 2 seconds to finish; if it doesn't, the hook kills it and moves on, so a stalled disk can't hold the hook past Claude Code's timeout. If it fails, an allowed or approval call is blocked. To let calls through without an audit record, add `--allow-audit-failure`; a `block` decision still blocks.

Each line has `decision` (the policy result) and `hook_decision` (what the hook told Claude Code: `allow`, `ask` or `block`). `executed` is what the hook knows when it exits, so it is `false` for an ask: the call runs only if it's approved afterwards, and only a PostToolUse hook can see that.

## Managed deployments

For a machine you manage, put the hook in managed settings, where project settings can't remove it or turn it off. Use exec form with absolute paths, so neither `PATH` nor a shell is involved, and clear `NODE_OPTIONS`, which a project's `env` block could otherwise set to load code into the hook's `node`:

```json
{
  "env": { "NODE_OPTIONS": "" },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/node",
            "args": ["/usr/local/lib/node_modules/@jamjet/claude-code-hook/dist/bin.js", "--policy", "/etc/jamjet/policy.yaml"],
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Adjust the paths to where `node` and the package live (`npm root -g` prints the global package directory).

## Same policy, other places

The same `policy.yaml` is consumed by:

- **MCP stdio traffic** via [`@jamjet/mcp-shim`](https://npm.im/@jamjet/mcp-shim)
- **OpenAI Agents SDK** via [`@jamjet/openai-guardrail`](https://npm.im/@jamjet/openai-guardrail)
- **JamJet Python SDK** via [`jamjet`](https://pypi.org/project/jamjet/) on PyPI
- **JamJet TS SDK** via [`@jamjet/cloud`](https://www.npmjs.com/package/@jamjet/cloud) on npm

The hook is stricter than the other adapters. It refuses keys it doesn't enforce and patterns no Claude Code tool name can match, so a policy written for dotted MCP tool names (`payments.refund`) needs its own file for the hook.

## License

Apache-2.0
