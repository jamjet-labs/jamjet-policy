// Child process that appends one audit line. See audit.ts for why the write
// does not happen in the hook's own process. Exit 0 means the line is on disk.
import { appendAuditLineSync, type AuditWrite } from './audit.js'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const w = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as AuditWrite
  if (typeof w.dir !== 'string' || typeof w.ts !== 'string' || typeof w.line !== 'string') {
    throw new Error('bad audit write request')
  }
  appendAuditLineSync({ dir: w.dir, rotateDaily: w.rotateDaily !== false, ts: w.ts, line: w.line })
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
