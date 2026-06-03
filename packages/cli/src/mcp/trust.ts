import {
  loadTrustBaseline,
  approveServer,
  saveTrustBaseline,
  defaultTrustLockPath,
  sha256Canonical,
  type ToolDefinition,
} from '@jamjet/mcp-threat'
import { probeServerTools } from './probe.js'

export interface TrustReviewOptions {
  json?: boolean
  lockPath?: string
}

export function trustReview(opts: TrustReviewOptions = {}): void {
  const lockPath = opts.lockPath ?? defaultTrustLockPath()
  const baseline = loadTrustBaseline(lockPath)
  if (opts.json) {
    process.stdout.write(JSON.stringify(baseline, null, 2) + '\n')
    return
  }
  const names = Object.keys(baseline.servers)
  if (names.length === 0) {
    process.stdout.write('No servers approved yet. Run `jamjet mcp trust approve <name>`.\n')
    return
  }
  for (const name of names) {
    const server = baseline.servers[name]
    if (!server) continue
    const toolNames = Object.keys(server.tools)
    const shortFp = server.fingerprint.slice(0, 17)
    process.stdout.write(`${name}  (${shortFp}…)  approved ${server.approved_at}\n`)
    process.stdout.write(`  ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}: ${toolNames.join(', ')}\n`)
  }
}

export type ProbeFn = (opts: { command: string; args: string[]; env: Record<string, string> }) => Promise<ToolDefinition[]>

export interface TrustApproveOptions {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  lockPath?: string
  probe?: ProbeFn
}

export async function trustApprove(opts: TrustApproveOptions): Promise<void> {
  const lockPath = opts.lockPath ?? defaultTrustLockPath()
  const probe = opts.probe ?? ((o) => probeServerTools(o))
  const cmdLine = [opts.command, ...opts.args].join(' ')
  process.stdout.write(`Probing ${opts.name} (${cmdLine})...\n`)
  const tools = await probe({ command: opts.command, args: opts.args, env: opts.env })
  const fingerprint = sha256Canonical({ command: opts.command, args: opts.args })
  let baseline = loadTrustBaseline(lockPath)
  baseline = approveServer(baseline, opts.name, fingerprint, tools, new Date().toISOString())
  saveTrustBaseline(lockPath, baseline)
  const toolNames = tools.map((t) => t.name)
  process.stdout.write(
    `Approved ${opts.name} — ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'} pinned: ${toolNames.join(', ')}\n`,
  )
  process.stdout.write(`Lock: ${lockPath}\n`)
}
