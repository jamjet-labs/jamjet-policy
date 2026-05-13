# @jamjet/cli

JamJet CLI — audit, approval, and Cloud Sync daemon for the [JamJet portable policy layer](https://github.com/jamjet-labs/jamjet-policy).

## Install

```bash
npm install -g @jamjet/cli
```

## Commands

### Local-only (no Cloud)

```bash
jamjet audit show [--date YYYY-MM-DD] [--adapter <name>]
jamjet approve <run-id>
jamjet reject  <run-id>
```

Audit events are read from `~/.jamjet/audit/<YYYY-MM-DD>/<adapter>.jsonl`. Pending approvals live in `~/.jamjet/pending/<run-id>.json`.

### Cloud Sync

```bash
jamjet cloud link              # interactive device-auth → writes ~/.jamjet/config.yaml
jamjet cloud whoami            # show current project + last-4 of API key + api base
jamjet sync start              # foreground daemon (Ctrl-C to stop)
jamjet sync install            # macOS launchd / Linux systemd unit
jamjet sync status [--json]    # ok / offline / degraded / unauthorized / not_running
jamjet sync verify <date>      # local-side drift detection (R4)
jamjet sync stop               # SIGTERM the running daemon
```

## Configuration

Two sources, env wins:

`~/.jamjet/config.yaml` (`0600` perms, written by `jamjet cloud link`):
```yaml
cloud:
  project_id: 11111111-2222-3333-4444-555555555555
  api_key: jj_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  api_base: https://api.jamjet.dev
  args_redaction: full         # full (default) | hash | none
  push: interesting            # interesting (default) | all
  poll_interval_seconds: 2
  drainer_interval_seconds: 1
  outbox_max_events: 100000
  outbox_max_age_days: 7
```

Env overrides (any of these win over the file):
```bash
JAMJET_CLOUD_TOKEN=jj_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
JAMJET_PROJECT=<uuid>
JAMJET_API_BASE=https://api.jamjet.dev
JAMJET_ARGS_REDACTION=full
```

## Privacy: args redaction

Tool-call `args` are stripped by default (`args_redaction: full`). Cloud sees decision metadata but never tool argument content.

| Mode | What ships to Cloud |
|---|---|
| `full` (default) | `args: {redacted: true}` |
| `hash` | `args: {redacted: true, sha256: "<hex>"}` — proves event happened against specific args without revealing content |
| `none` | full args — operator explicit opt-in |

## What flows where

```
adapters (openai-guardrail, mcp-shim, claude-code-hook, sdks)
  └─→ ~/.jamjet/audit/<date>/*.jsonl     (always written; never blocks adapters — R1)
  └─→ ~/.jamjet/pending/<run_id>.json    (only for WAITING_FOR_APPROVAL)

  jamjet sync daemon
    ├─ tailer       (chokidar — append-only reader on today's JSONL)
    ├─ redactor     (applyRedaction — runs BEFORE write to outbox)
    ├─ outbox       (better-sqlite3 — durable queue with retry schedule)
    ├─ drainer      (1s default; POST /v1/policy-audit/events; R3 dedup)
    ├─ approval-poller (2s default; GET /v1/policy-audit/approvals/pending)
    │                  → writes ~/.jamjet/pending/resolved/<run_id>.{approved,rejected}
    │                  → adapters pick up the marker (existing Phase 2 contract)
    ├─ cap-enforcer (60s; age + size policies; R7/R8 dropped.log)
    └─ startup-replay (R12 — enqueue events newer than last_synced_ts on start)
```

## Reliability invariants

| | |
|---|---|
| R1 | Local audit JSONL is never blocked by Cloud — daemon down means local writes unchanged |
| R3 | Daemon can be `kill -9`'d mid-batch — outbox is durable; Cloud-side dedupe makes net effect exactly-once |
| R7 | Outbox capped at 7 days / 100k events (configurable); breach → status `degraded`, oldest events drop to `~/.jamjet/sync/dropped.log` |
| R9 | PII default-on: args redacted by default; opt-in to ship content |
| R10 | Same protocol used by daemon (dev laptop) and direct-push (serverless adapters) — interchangeable on Cloud side |
| R11 | One daemon per host enforced via PID lock at `~/.jamjet/sync/daemon.pid` |
| R12 | Startup replay enqueues events newer than `last_synced_ts` so daemon downtime loses nothing |

## Operator runbook

| Symptom | Where to look |
|---|---|
| `sync status` shows `unauthorized` | Token rotated or revoked — `jamjet cloud link` again |
| `sync status` shows `degraded` | Outbox depth > 1000 or cap-breach — check `~/.jamjet/sync/dropped.log` and `http_5xx_total` |
| `sync status` shows `not_running` but daemon should be live | `tail ~/.jamjet/sync/daemon.log` (when installed via `sync install`) |
| Events visible in `~/.jamjet/audit/*.jsonl` but not on dashboard | `sync verify <date>` to count local; drainer may be backed off |
| Daemon won't start: "another daemon is already running" | `jamjet sync stop`, then start again. Stale lock auto-reclaims if PID is dead |

## License

Apache-2.0
