import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadPinFile, savePin } from './tool-pins.js'

const USAGE = [
  'Usage:',
  '  jamjet-mcp-shim pins approve --server <name> --tool <name> --hash sha256:<hex> [--pins <file>]',
  '  jamjet-mcp-shim pins list [--pins <file>]',
].join('\n')

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function defaultPinsPath(): string {
  return process.env.JAMJET_TOOL_PINS || join(homedir(), '.jamjet', 'mcp-tool-pins.json')
}

/** `pins` subcommands. Returns an exit code and text for stdout/stderr. */
export function runPinsCommand(argv: string[], now: () => string = () => new Date().toISOString()): { code: number; out: string } {
  const [sub, ...rest] = argv
  const pins = flag(rest, '--pins') ?? defaultPinsPath()
  if (sub === 'approve') {
    const server = flag(rest, '--server')
    const tool = flag(rest, '--tool')
    const hash = flag(rest, '--hash')
    if (!server || !tool || !hash) return { code: 64, out: USAGE }
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) return { code: 64, out: `invalid --hash '${hash}' (expected sha256:<64 hex>)` }
    try {
      savePin(pins, server, tool, { hash, pinned_at: now(), source: 'approved' })
    } catch (err) {
      return { code: 1, out: `could not update ${pins}: ${(err as Error).message}` }
    }
    return { code: 0, out: `approved ${server}/${tool} = ${hash} in ${pins}` }
  }
  if (sub === 'list') {
    try {
      const file = loadPinFile(pins)
      const lines = [`# ${pins}`]
      for (const [server, tools] of Object.entries(file.servers)) {
        for (const [tool, e] of Object.entries(tools)) {
          lines.push(`${server}\t${tool}\t${e.hash}\t${e.source ?? ''}\t${e.pinned_at ?? ''}`)
        }
      }
      return { code: 0, out: lines.join('\n') }
    } catch (err) {
      return { code: 1, out: `could not read ${pins}: ${(err as Error).message}` }
    }
  }
  return { code: 64, out: USAGE }
}
