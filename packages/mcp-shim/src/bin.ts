#!/usr/bin/env node
import { runShim } from './shim.js'
import { runServeSelf } from './serve-self.js'

interface ShimArgs {
  mode: 'shim'
  policyPath?: string
  serverName: string
  command: string
  args: string[]
}

interface ServeSelfArgs {
  mode: 'serve-self'
  policyPath?: string
}

type ParsedArgs = ShimArgs | ServeSelfArgs

const USAGE = [
  'Usage:',
  '  jamjet-mcp-shim [--policy <path>] [--server <name>] -- <mcp-server> [args...]',
  '  jamjet-mcp-shim --serve-self [--policy <path>]',
  '',
  'Modes:',
  '  shim         (default) — intercept tools/call to the downstream MCP server',
  '  --serve-self           — run as a standalone MCP server exposing policy_evaluate, policy_list_rules, policy_load_info',
].join('\n')

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2)

  if (argv.includes('--serve-self')) {
    const policyFlag = argv.indexOf('--policy')
    return {
      mode: 'serve-self',
      policyPath: policyFlag >= 0 ? argv[policyFlag + 1] : undefined,
    }
  }

  const sep = argv.indexOf('--')
  if (sep === -1) {
    process.stderr.write(USAGE + '\n')
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
    mode: 'shim',
    policyPath: policyFlag >= 0 ? flags[policyFlag + 1] : undefined,
    serverName: serverFlag >= 0 ? (flags[serverFlag + 1] ?? 'mcp') : 'mcp',
    command: cmd[0]!,
    args: cmd.slice(1),
  }
}

const opts = parseArgs()
if (opts.mode === 'serve-self') {
  runServeSelf({ policyPath: opts.policyPath }).then((code) => process.exit(code))
} else {
  runShim(opts).then((code) => process.exit(code ?? 0))
}
