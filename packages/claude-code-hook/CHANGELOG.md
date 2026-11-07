# @jamjet/claude-code-hook

## 0.2.0

The hook now fails closed. Check your setup against the README before upgrading: a broken policy that 0.1.x let through now blocks every tool call.

### Changed
- Every error inside the hook exits 2, which Claude Code treats as a block. 0.1.x exited 1 on a missing or invalid policy, an unknown action (`blok`), bad stdin, or an unwritable audit directory, and Claude Code runs the tool on exit 1.
- `require_approval` no longer blocks. The hook exits 0 and prints `permissionDecision: "ask"`, which sends the call to Claude Code's permission prompt (`default`, `acceptEdits`, `auto`, `dontAsk`). In `plan`, `bypassPermissions`, an unknown mode, or input with no `permission_mode`, it still blocks.
- The policy file is `--policy <path>`, else `JAMJET_POLICY_FILE` (or `JAMJET_POLICY`), else `~/.jamjet/policy.yaml`. A `policy.yaml` in the working directory is no longer read. A leading `~/` is expanded; after that the policy path, `HOME` and `audit.destination` must be absolute. The policy must be a regular file under 1 MiB.
- The policy is read strictly. Unknown keys are refused at every level, including `default`, `budgets` and `approval_timeout`, which this hook doesn't enforce. Patterns that can never match a Claude Code tool name are refused: characters outside `A-Z a-z 0-9 _ -` plus `*` `?`, more than 128 literal characters, or a wrong-case built-in name such as `bash`.
- MCP tools match by full name (`mcp__<server>__<tool>`). Block, ask and audit rules also match the bare tool name, as before; allow rules don't. An allow written for the built-in `Read` no longer allows `mcp__anything__Read`. Allow MCP tools with `mcp__github__*` or `mcp__*__query`.
- Globs are matched without regular expressions. A pattern with many `*` could take seconds as a regex, past the hook timeout. `*` and `?` now also match newlines.
- `tool_name` must be a name Claude Code can send (1 to 128 characters of `A-Z a-z 0-9 _ -`).
- The decision is made before the audit write. If the write fails, an allowed or approval call is blocked; `--allow-audit-failure` lets it through with a warning. A block always stays a block.
- The audit line is written by a child process (`dist/audit-writer.js`) with a 2 second deadline, after which the hook kills it and treats the write as failed. Node can't exit while one of its own threads is stuck in a blocking call, so a deadline inside the hook's process wasn't enough. The file is opened non-blocking and without following symlinks and must be a regular file. A FIFO at that path used to hang the hook until Claude Code's timeout, which lets the tool run. New audit directories are `0700` and files `0600`. The child adds roughly 40 ms per call.
- Audit lines add `hook_decision` (`allow`, `ask` or `block`) and `server_source` (from the `mcp_server` field Claude Code sends). `executed` stays `false` for an ask, since the hook exits before you answer.
- Only the decision is written to stdout. Anything else that prints there (yaml does with `LOG_TOKENS` set) goes to stderr, so the JSON decision can't be corrupted.
- Unknown flags, a repeated `--policy`, conflicting `JAMJET_POLICY_FILE` and `JAMJET_POLICY`, and stdin for any event other than `PreToolUse` are errors.
- A failed import of the hook's own dependencies exits 2 instead of Node's default exit 1.

### Docs
- README wires the hook into `~/.claude/settings.json` or `.claude/settings.json` with the `matcher` / `hooks` shape Claude Code reads, with `"timeout": 10` and `"onFailure": "block"`. The old example used `~/.config/claude-code/settings.json`, which is not a Claude Code settings location, and a flat `{ "command" }` entry, which is not the shape it expects.
- New sections on writing rules, MCP matching, and managed deployments (exec form with absolute paths, `NODE_OPTIONS` cleared in managed `env`). The `npx` suggestion is gone.

## 0.1.0 — 2026-05-11

### Added
- Initial release. Reads Claude Code PreToolUse hook JSON from stdin, applies JamJet policy via `@jamjet/cloud`'s `PolicyEvaluator`, writes audit event to `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl`, exits with appropriate code (0=allow/audit, 2=block/approval).
- Strips `mcp__<server>__` prefix from Claude Code's MCP tool names so policies remain MCP-server-agnostic.
- Loads policy from `--policy <path>`, `JAMJET_POLICY_FILE`, `./policy.yaml`, or `~/.jamjet/policy.yaml` (in that order).
- Conformance suite (32 cases) passes — same suite as `@jamjet/mcp-shim`, `@jamjet/openai-guardrail`, and the JamJet Python/TS SDKs.

### Known limitations (v0.1)
- `require_approval` rules surface as a block + audit event. Full approval flow with `jamjet approve <run-id>` lands in v0.2 (waiting on the `@jamjet/cli` package).
