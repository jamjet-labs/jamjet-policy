import { sha256Canonical } from '@jamjet/mcp-threat'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuthzAction, PolicyVerdict } from './types.js'

export const RECEIPT_VERSION = 'agentboundary/v0.2-alpha+ext-authz'

export type ReceiptDecision = 'ALLOWED' | 'BLOCKED' | 'WAITING_FOR_APPROVAL'

export interface PolicyReceipt {
  version: string
  issued_at: string
  server: string
  tool: string
  action: 'tools/call'
  policy: { decision: ReceiptDecision; matched_pattern: string | null }
  arguments_hash: string
  approval?: { run_id: string; status: 'pending' | 'approved' | 'rejected' }
  receipt_hash: string
}

export function verdictToDecision(kind: PolicyVerdict['kind']): ReceiptDecision {
  if (kind === 'BLOCK') return 'BLOCKED'
  if (kind === 'PENDING') return 'WAITING_FOR_APPROVAL'
  return 'ALLOWED'
}

export function buildPolicyReceipt(
  action: AuthzAction,
  decision: ReceiptDecision,
  matchedPattern: string | null,
  issuedAt: string,
  approval?: { run_id: string; status: 'pending' | 'approved' | 'rejected' },
): PolicyReceipt {
  const body: Omit<PolicyReceipt, 'receipt_hash'> = {
    version: RECEIPT_VERSION,
    issued_at: issuedAt,
    server: action.server,
    tool: action.tool,
    action: 'tools/call',
    policy: { decision, matched_pattern: matchedPattern },
    arguments_hash: sha256Canonical(action.args),
    ...(approval ? { approval } : {}),
  }
  return { ...body, receipt_hash: sha256Canonical(body) }
}

export function appendReceipt(path: string, receipt: PolicyReceipt): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(receipt) + '\n', 'utf-8')
}
