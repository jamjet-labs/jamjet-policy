#!/usr/bin/env node
import { buildEvaluator } from './policy.js'
import { createServer } from './server.js'

function opt(args: string[], name: string, dflt?: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}

const args = process.argv.slice(2)
const policyPath = opt(args, '--policy')
const port = Number(opt(args, '--port', '9191'))
const auditPath = opt(args, '--audit', `${process.env.HOME}/.jamjet/audit/ext-authz-receipts.jsonl`)!
const defaultServer = opt(args, '--server-name', 'mcp')!

const evaluator = buildEvaluator(policyPath)
const server = createServer({ evaluator, auditPath, now: () => new Date().toISOString(), defaultServer })
server.listen(port, () => process.stderr.write(`jamjet-ext-authz listening on :${port}\n`))
