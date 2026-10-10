#!/usr/bin/env node
import { homedir } from 'node:os'
import { CedarLoadError } from '@jamjet/cedar'
import { buildEvaluator, buildCedar } from './policy.js'
import { createServer } from './server.js'
import { createHoldStore } from './hold.js'

function opt(args: string[], name: string, dflt?: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}

const argv = process.argv.slice(2)
const sub = argv[0]
const holdDir = opt(argv, '--holds', `${homedir()}/.jamjet/ext-authz-holds`)!

if (sub === 'approve' || sub === 'reject') {
  const runId = argv[1]
  if (!runId) { process.stderr.write('usage: jamjet-ext-authz approve|reject <runId>\n'); process.exit(2) }
  // resolve() validates the runId format and returns false for unknown/invalid ids,
  // so a malformed or path-traversing argument is rejected, not acted on.
  const ok = createHoldStore(holdDir).resolve(runId, sub === 'approve' ? 'approved' : 'rejected')
  process.stderr.write(ok ? `${sub}d ${runId}\n` : `no such hold ${runId}\n`)
  process.exit(ok ? 0 : 1)
}

const policyPath = opt(argv, '--policy')
const port = Number(opt(argv, '--port', '9191'))
const auditPath = opt(argv, '--audit', `${homedir()}/.jamjet/audit/ext-authz-receipts.jsonl`)!
const defaultServer = opt(argv, '--server-name', 'mcp')!
const approvalBaseUrl = opt(argv, '--approval-url', `http://localhost:${port}/approve`)!

// A Cedar flag given without a value must not quietly fall back to "no Cedar".
for (const flag of ['--cedar', '--cedar-schema', '--principal-header', '--server-header']) {
  const i = argv.indexOf(flag)
  if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1]!.startsWith('--'))) {
    process.stderr.write(`${flag} needs a value\n`)
    process.exit(2)
  }
}
const cedarPath = opt(argv, '--cedar')
const cedarSchemaPath = opt(argv, '--cedar-schema')
const principalHeader = opt(argv, '--principal-header')
const serverHeader = opt(argv, '--server-header')
if ((principalHeader || serverHeader) && !cedarPath) {
  process.stderr.write('--principal-header and --server-header only apply with --cedar\n')
  process.exit(2)
}
if (cedarSchemaPath && !cedarPath) {
  process.stderr.write('--cedar-schema needs --cedar <policies.cedar>\n')
  process.exit(2)
}

// Fail closed at startup: a Cedar policy set that does not load and validate is never
// skipped, the PDP refuses to start instead.
let cedar = null
if (cedarPath) {
  try {
    cedar = buildCedar(cedarPath, cedarSchemaPath)
  } catch (e) {
    process.stderr.write(e instanceof CedarLoadError ? `${e.message}\n` : `failed to load Cedar policies: ${(e as Error).message}\n`)
    process.exit(1)
  }
  for (const w of cedar.warnings) process.stderr.write(`cedar warning: ${w}\n`)
}

const server = createServer({
  evaluator: buildEvaluator(policyPath),
  cedar,
  ...(principalHeader ? { principalHeader } : {}),
  ...(serverHeader ? { serverHeader } : {}),
  auditPath,
  now: () => new Date().toISOString(),
  defaultServer,
  holds: createHoldStore(holdDir),
  approvalBaseUrl,
})
server.listen(port, () => process.stderr.write(`jamjet-ext-authz listening on :${port} (holds: ${holdDir}${cedar ? `, cedar: ${cedar.policyIds.length} policies` : ''})\n`))
