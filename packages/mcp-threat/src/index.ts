export const MCP_THREAT_VERSION = '0.1.0'

export * from './types.js'
export { canonicalize, sha256Canonical, hashToolDefinition } from './fingerprint.js'
export { detectDrift } from './detectors/drift.js'
export { detectShadowing, normalizeName } from './detectors/shadowing.js'
export { detectTokenPassthrough, parseJwtAudience } from './detectors/token.js'
export { decideFromFindings, strictest, DECISION_SEVERITY } from './decide.js'
export { parseThreatConfig, loadThreatConfig, THREAT_DEFAULTS } from './threat-config.js'
export {
  loadTrustBaseline, saveTrustBaseline, approveServer, defaultTrustLockPath,
} from './trust-lock.js'
export { evaluateToolsList, type ToolsListEvaluation } from './list-eval.js'
export { evaluateCall, type CallEvaluation, type CallEvaluationInput } from './call-eval.js'
export { buildMcpSecurityReceipt, appendReceipt, RECEIPT_VERSION } from './receipt.js'
