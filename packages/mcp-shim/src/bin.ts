#!/usr/bin/env node
import { runShim } from './shim.js'

interface ParsedArgs {
  policyPath?: string
  serverName: string
  command: string
  args: string[]
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2)
  const sep = argv.indexOf('--')
  if (sep === -1) {
    process.stderr.write('Usage: jamjet-mcp-shim [--policy <path>] [--server <name>] -- <mcp-server> [args...]\n')
    process.exit(64)
  }
  const flags = argv.slice(0, sep)
  const cmd = argv.slice(sep + 1)
  if (cmd.length === 0) {
    process.stderr.write('jamjet-mcp-shim: missing MCP server command after --\n')
    process.exit(64)
  }
  const policyFlag = flags.indexOf('--policy')
  const serverFlag = flags.indexOf('--server')
  return {
    policyPath: policyFlag >= 0 ? flags[policyFlag + 1] : undefined,
    serverName: serverFlag >= 0 ? (flags[serverFlag + 1] ?? 'mcp') : 'mcp',
    command: cmd[0]!,
    args: cmd.slice(1),
  }
}

const opts = parseArgs()
runShim(opts).then((code) => process.exit(code ?? 0))
