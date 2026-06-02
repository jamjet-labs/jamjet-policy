import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Decision, McpSecurityReceipt, ThreatFinding } from './types.js'
import { sha256Canonical } from './fingerprint.js'

export const RECEIPT_VERSION = 'agentboundary/v0.2-alpha+mcp'

export function buildMcpSecurityReceipt(
  finding: ThreatFinding,
  decision: Decision,
  action: 'tools/call' | 'tools/list',
  issuedAt: string,
): McpSecurityReceipt {
  const body: Omit<McpSecurityReceipt, 'receipt_hash'> = {
    version: RECEIPT_VERSION,
    issued_at: issuedAt,
    server: finding.server,
    tool: finding.tool,
    action,
    policy: { decision, risk_class: finding.risk_class },
    finding: finding.risk_class,
    detail: finding.detail,
    risk_class: finding.risk_class,
    ...(finding.baseline_hash ? { baseline_hash: finding.baseline_hash } : {}),
    ...(finding.observed_hash ? { observed_hash: finding.observed_hash } : {}),
  }
  return { ...body, receipt_hash: sha256Canonical(body) }
}

export function appendReceipt(path: string, receipt: McpSecurityReceipt): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(receipt) + '\n', 'utf-8')
}
