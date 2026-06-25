#!/usr/bin/env node
import { buildEvaluator } from './policy.js'
import { createServer } from './server.js'
import { createHoldStore } from './hold.js'

function opt(args: string[], name: string, dflt?: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}

const argv = process.argv.slice(2)
const sub = argv[0]
const holdDir = opt(argv, '--holds', `${process.env.HOME}/.jamjet/ext-authz-holds`)!

if (sub === 'approve' || sub === 'reject') {
  const runId = argv[1]
  if (!runId) { process.stderr.write('usage: jamjet-ext-authz approve|reject <runId>\n'); process.exit(2) }
  const ok = createHoldStore(holdDir).resolve(runId, sub === 'approve' ? 'approved' : 'rejected')
  process.stderr.write(ok ? `${sub}d ${runId}\n` : `no such hold ${runId}\n`)
  process.exit(ok ? 0 : 1)
}

const policyPath = opt(argv, '--policy')
const port = Number(opt(argv, '--port', '9191'))
const auditPath = opt(argv, '--audit', `${process.env.HOME}/.jamjet/audit/ext-authz-receipts.jsonl`)!
const defaultServer = opt(argv, '--server-name', 'mcp')!
const approvalBaseUrl = opt(argv, '--approval-url', `http://localhost:${port}/approve`)!

const server = createServer({
  evaluator: buildEvaluator(policyPath),
  auditPath,
  now: () => new Date().toISOString(),
  defaultServer,
  holds: createHoldStore(holdDir),
  approvalBaseUrl,
})
server.listen(port, () => process.stderr.write(`jamjet-ext-authz listening on :${port} (holds: ${holdDir})\n`))
