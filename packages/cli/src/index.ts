#!/usr/bin/env node
import { auditShow } from './audit-show.js'
import { approveRunId } from './approve.js'
import { cloudLink } from './cloud/link.js'
import { loadConfig } from './cloud/config.js'
import { Daemon } from './sync/daemon.js'
import { syncStatus } from './sync/status.js'
import { syncVerify } from './sync/verify.js'
import { syncInstall } from './sync/install.js'
import { resolveServerCommand } from './mcp/resolve.js'
import { trustReview, trustApprove } from './mcp/trust.js'

const VERSION = '0.2.0'

function printHelp(): void {
  process.stdout.write(`jamjet — JamJet CLI (v${VERSION})

Usage:
  jamjet audit show [--date YYYY-MM-DD] [--adapter <name>]
  jamjet approve <run-id>
  jamjet reject  <run-id>

Cloud Sync:
  jamjet cloud link [--api-base URL]
  jamjet cloud whoami
  jamjet sync start
  jamjet sync install
  jamjet sync status [--json]
  jamjet sync verify <YYYY-MM-DD>
  jamjet sync stop

MCP trust:
  jamjet mcp trust review [--json]
  jamjet mcp trust approve <name> [-- <cmd> <args...>]

Misc:
  jamjet --version
  jamjet --help
`)
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  return args[i + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function splitOnDoubleDash(args: string[]): { before: string[]; after: string[] | undefined } {
  const i = args.indexOf('--')
  if (i < 0) return { before: args, after: undefined }
  return { before: args.slice(0, i), after: args.slice(i + 1) }
}

const argv = process.argv.slice(2)

async function main(): Promise<void> {
  if (hasFlag(argv, '--version') || hasFlag(argv, '-V') || argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv.length === 0) {
    printHelp()
    return
  }

  const [cmd, sub, ...rest] = argv

  if (cmd === 'audit' && sub === 'show') {
    auditShow({
      date: getFlag(rest, '--date'),
      adapter: getFlag(rest, '--adapter'),
    })
    return
  }

  if (cmd === 'approve' || cmd === 'reject') {
    if (!sub) {
      process.stderr.write(`Usage: jamjet ${cmd} <run-id>\n`)
      process.exitCode = 64
      return
    }
    const ok = approveRunId({ runId: sub, action: cmd })
    process.exitCode = ok ? 0 : 1
    return
  }

  if (cmd === 'cloud' && sub === 'link') {
    await cloudLink({ apiBase: getFlag(rest, '--api-base') })
    return
  }

  if (cmd === 'cloud' && sub === 'whoami') {
    try {
      const cfg = loadConfig()
      process.stdout.write(
        `project: ${cfg.cloud.project_id}\n` +
          `key ends with: ...${cfg.cloud.api_key.slice(-4)}\n` +
          `api base: ${cfg.cloud.api_base}\n`,
      )
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`)
      process.exitCode = 1
    }
    return
  }

  if (cmd === 'sync' && sub === 'start') {
    const cfg = loadConfig()
    const daemon = new Daemon({ config: cfg })
    await daemon.start()
    process.stderr.write(`[jamjet-sync] daemon started (pid ${process.pid})\n`)
    // Block forever; signal handlers in lock.ts handle SIGTERM/SIGINT.
    await new Promise<void>(() => {})
    return
  }

  if (cmd === 'sync' && sub === 'install') {
    await syncInstall()
    return
  }

  if (cmd === 'sync' && sub === 'status') {
    await syncStatus({ json: hasFlag(rest, '--json') })
    return
  }

  if (cmd === 'sync' && sub === 'verify') {
    const date = rest[0]
    if (!date) {
      process.stderr.write('sync verify: missing YYYY-MM-DD\n')
      process.exitCode = 64
      return
    }
    const result = await syncVerify({ date })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  if (cmd === 'sync' && sub === 'stop') {
    const { existsSync, readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const lockPath = join(homedir(), '.jamjet', 'sync', 'daemon.pid')
    if (!existsSync(lockPath)) {
      process.stdout.write('daemon not running\n')
      return
    }
    let info: { pid: number }
    try {
      info = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }
      if (typeof info?.pid !== 'number') throw new Error('missing pid field')
    } catch (e) {
      process.stderr.write(
        `corrupt lock file at ${lockPath}: ${(e as Error).message}. ` +
          `Delete it manually if no daemon is running.\n`,
      )
      process.exitCode = 1
      return
    }
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch (e) {
      process.stderr.write(
        `failed to signal pid ${info.pid}: ${(e as Error).message}\n`,
      )
      process.exitCode = 1
      return
    }
    process.stdout.write(`sent SIGTERM to pid ${info.pid}\n`)
    return
  }

  if (cmd === 'mcp' && sub === 'trust') {
    const action = rest[0]
    if (action === 'review') {
      trustReview({ json: hasFlag(rest, '--json') })
      return
    }
    if (action === 'approve') {
      const { before, after } = splitOnDoubleDash(rest.slice(1))
      const name = before[0]
      if (!name) {
        process.stderr.write('Usage: jamjet mcp trust approve <name> [-- <cmd> <args...>]\n')
        process.exitCode = 64
        return
      }
      const resolved = resolveServerCommand(name, after)
      await trustApprove({ name, command: resolved.command, args: resolved.args, env: resolved.env })
      return
    }
    process.stderr.write('Usage: jamjet mcp trust review|approve\n')
    process.exitCode = 64
    return
  }

  process.stderr.write(`unknown command: ${argv.join(' ')}\n`)
  printHelp()
  process.exitCode = 64
}

main().catch((e) => {
  process.stderr.write(`error: ${(e as Error).message ?? e}\n`)
  process.exitCode = 1
})
