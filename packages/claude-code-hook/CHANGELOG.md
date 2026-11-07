# @jamjet/claude-code-hook

## 0.2.0

The hook now fails closed. Check your setup against the README before upgrading: a broken policy that 0.1.x let through now blocks every tool call.

### Changed
- Every error exits 2, which Claude Code treats as a block. 0.1.x exited 1 on a missing or invalid policy, an unknown action (`blok`), bad stdin, or an unwritable audit directory, and Claude Code runs the tool on exit 1.
- `require_approval` no longer blocks. The hook exits 0 and prints `permissionDecision: "ask"`, which sends the call to Claude Code's permission prompt (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`). In `bypassPermissions`, an unknown mode, or input with no `permission_mode`, it still blocks.
- The policy file is `--policy <path>`, else `JAMJET_POLICY_FILE` (or `JAMJET_POLICY`), else `~/.jamjet/policy.yaml`. A `policy.yaml` in the working directory is no longer read. A leading `~/` is expanded; after that the policy path, `HOME` and `audit.destination` must be absolute. The policy must be a regular file under 1 MiB.
- Rules whose `match` is empty or starts with `mcp__` are refused: rules see MCP tools without that prefix, so they never matched. An `audit` block that is not a mapping, has unknown keys, or has a non-boolean `rotate_daily` is refused.
- Only the decision is written to stdout. Anything else that prints there (yaml does with `LOG_TOKENS` set) goes to stderr, so the JSON decision can't be corrupted.
- The decision is made before the audit write. If the write fails, an allowed or approval call is blocked; `--allow-audit-failure` lets it through with a warning. A block always stays a block.
- Unknown flags, a repeated `--policy`, conflicting `JAMJET_POLICY_FILE` and `JAMJET_POLICY`, and stdin for any event other than `PreToolUse` are errors.
- A failed import of the hook's own dependencies exits 2 instead of Node's default exit 1.

### Docs
- README wires the hook into `~/.claude/settings.json` or `.claude/settings.json` with the `matcher` / `hooks` shape Claude Code reads. The old example used `~/.config/claude-code/settings.json`, which is not a Claude Code settings location, and a flat `{ "command" }` entry, which is not the shape it expects.

## 0.1.0 — 2026-05-11

### Added
- Initial release. Reads Claude Code PreToolUse hook JSON from stdin, applies JamJet policy via `@jamjet/cloud`'s `PolicyEvaluator`, writes audit event to `~/.jamjet/audit/<YYYY-MM-DD>/claude-code-hook.jsonl`, exits with appropriate code (0=allow/audit, 2=block/approval).
- Strips `mcp__<server>__` prefix from Claude Code's MCP tool names so policies remain MCP-server-agnostic.
- Loads policy from `--policy <path>`, `JAMJET_POLICY_FILE`, `./policy.yaml`, or `~/.jamjet/policy.yaml` (in that order).
- Conformance suite (32 cases) passes — same suite as `@jamjet/mcp-shim`, `@jamjet/openai-guardrail`, and the JamJet Python/TS SDKs.

### Known limitations (v0.1)
- `require_approval` rules surface as a block + audit event. Full approval flow with `jamjet approve <run-id>` lands in v0.2 (waiting on the `@jamjet/cli` package).
