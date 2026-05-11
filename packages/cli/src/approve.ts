import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ApproveOptions {
  runId: string
  pendingDir?: string
  action: 'approve' | 'reject'
}

export function approveRunId(opts: ApproveOptions): boolean {
  const pendingDir = opts.pendingDir ?? join(homedir(), '.jamjet', 'pending')
  const pendingPath = join(pendingDir, `${opts.runId}.json`)
  if (!existsSync(pendingPath)) {
    process.stderr.write(`No pending approval found for run id: ${opts.runId}\n`)
    return false
  }
  const data = JSON.parse(readFileSync(pendingPath, 'utf-8'))
  const markerSuffix = opts.action === 'approve' ? 'approved' : 'rejected'
  const markerDir = join(pendingDir, 'resolved')
  mkdirSync(markerDir, { recursive: true })
  const markerPath = join(markerDir, `${opts.runId}.${markerSuffix}`)
  writeFileSync(markerPath, JSON.stringify({ ...data, status: markerSuffix }, null, 2), 'utf-8')
  unlinkSync(pendingPath)
  process.stdout.write(`${markerSuffix}: ${opts.runId} (${data.tool ?? '<unknown tool>'})\n`)
  return true
}
