#!/usr/bin/env node
import { auditShow } from './audit-show.js'
import { approveRunId } from './approve.js'

const VERSION = '0.1.0'

function printHelp(): void {
  process.stdout.write(`jamjet — JamJet CLI (v${VERSION})

Usage:
  jamjet audit show [--date YYYY-MM-DD] [--adapter <name>]
  jamjet approve <run-id>
  jamjet reject  <run-id>
  jamjet --version
  jamjet --help

Examples:
  jamjet audit show
  jamjet audit show --adapter claude-code-hook
  jamjet approve run_a1b2c3
`)
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  return args[i + 1]
}

const argv = process.argv.slice(2)
const sub = argv[0]

if (!sub || sub === '--help' || sub === '-h') {
  printHelp()
  process.exit(0)
}

if (sub === '--version' || sub === '-v') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (sub === 'audit') {
  if (argv[1] !== 'show') {
    process.stderr.write(`Unknown audit subcommand: ${argv[1] ?? ''}\n`)
    process.exit(64)
  }
  const rest = argv.slice(2)
  auditShow({
    date: getFlag(rest, '--date'),
    adapter: getFlag(rest, '--adapter'),
  })
  process.exit(0)
}

if (sub === 'approve' || sub === 'reject') {
  const runId = argv[1]
  if (!runId) {
    process.stderr.write(`Usage: jamjet ${sub} <run-id>\n`)
    process.exit(64)
  }
  const ok = approveRunId({ runId, action: sub })
  process.exit(ok ? 0 : 1)
}

process.stderr.write(`Unknown command: ${sub}\n`)
printHelp()
process.exit(64)
