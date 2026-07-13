import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAuthZen, AUTHZEN_EVALUATION_PATH, AUTHZEN_EVALUATIONS_PATH } from '../src/authzen.js'
import { buildEvaluator } from '../src/policy.js'
import { createHoldStore } from '../src/hold.js'
import type { AuthzDepsV2 } from '../src/handle.js'

const POLICY =
  'version: 1\nrules:\n  - match: "delete_*"\n    action: block\n  - match: "payments.*"\n    action: require_approval\n'

function makeDeps(): AuthzDepsV2 {
  const dir = mkdtempSync(join(tmpdir(), 'authzen-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, POLICY, 'utf-8')
  return {
    evaluator: buildEvaluator(policyPath),
    auditPath: join(dir, 'receipts.jsonl'),
    now: () => '2026-07-13T00:00:00.000Z',
    defaultServer: 'mcp',
    holds: createHoldStore(join(dir, 'holds')),
    approvalBaseUrl: 'http://localhost:9191/approve',
  }
}

function evaluation(action: string, resourceProps?: Record<string, unknown>) {
  return JSON.stringify({
    subject: { type: 'user', id: 'alice@example.com' },
    action: { name: action },
    resource: { type: 'mcp_tool', id: action, ...(resourceProps ? { properties: resourceProps } : {}) },
  })
}

function post(deps: AuthzDepsV2, path: string, body: string, headers: Record<string, string | undefined> = {}) {
  const res = handleAuthZen(path, 'POST', body, headers, deps)
  return { ...res, json: res.body ? JSON.parse(res.body) : null }
}

let deps: AuthzDepsV2
beforeEach(() => {
  deps = makeDeps()
})

describe('single evaluation', () => {
  it('permits an unmatched tool with decision true', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('search'))
    expect(r.status).toBe(200)
    expect(r.json.decision).toBe(true)
  })

  it('denies a blocked tool with 200 and decision false (deny is not an HTTP error)', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('delete_user'))
    expect(r.status).toBe(200)
    expect(r.json.decision).toBe(false)
    // MCP profile: the deny reason a PEP surfaces comes from context.reason.
    expect(String(r.json.context.reason)).toMatch(/block/i)
  })

  it('returns the receipt hash in the response context', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('search'))
    expect(r.json.context.receipt).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('appends a receipt for every decision', () => {
    post(deps, AUTHZEN_EVALUATION_PATH, evaluation('search'))
    post(deps, AUTHZEN_EVALUATION_PATH, evaluation('delete_user'))
    const lines = readFileSync(deps.auditPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).policy.decision).toBe('BLOCKED')
  })

  it('maps action.name to the policy tool and resource.properties.arguments to args', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer', { arguments: { amount: 5 } }))
    expect(r.json.decision).toBe(false)
    // Identical action must map to the same hold (args participate in the action hash).
    const again = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer', { arguments: { amount: 5 } }))
    expect(again.json.context.jamjet.approval_id).toBe(r.json.context.jamjet.approval_id)
    const other = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer', { arguments: { amount: 9 } }))
    expect(other.json.context.jamjet.approval_id).not.toBe(r.json.context.jamjet.approval_id)
  })
})

describe('approval bridge over AuthZen', () => {
  it('holds a require_approval tool: decision false with step-up instructions', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    expect(r.status).toBe(200)
    expect(r.json.decision).toBe(false)
    expect(r.json.context.reason).toBe('approval_required')
    expect(r.json.context.jamjet.approval_id).toMatch(/^run_[0-9a-f]{32}$/)
    expect(r.json.context.jamjet.approval_url).toContain(r.json.context.jamjet.approval_id)
    expect(r.json.context.jamjet.status).toBe('pending')
  })

  it('permits after approval and consumes the hold (single use)', () => {
    const first = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    const runId = first.json.context.jamjet.approval_id
    expect(deps.holds.resolve(runId, 'approved')).toBe(true)

    const second = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    expect(second.json.decision).toBe(true)
    expect(second.json.context.receipt).toMatch(/^sha256:/)

    // Consumed: the same action re-enters pending, it is not silently replayable.
    const third = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    expect(third.json.decision).toBe(false)
    expect(third.json.context.reason).toBe('approval_required')
  })

  it('keeps a rejected hold denied', () => {
    const first = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    deps.holds.resolve(first.json.context.jamjet.approval_id, 'rejected')
    const second = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('payments.transfer'))
    expect(second.json.decision).toBe(false)
    expect(second.json.context.jamjet.status).toBe('rejected')
  })
})

describe('request validation (fail closed)', () => {
  it('400 on invalid JSON', () => {
    expect(post(deps, AUTHZEN_EVALUATION_PATH, '{nope').status).toBe(400)
  })

  it.each([
    ['missing subject', { action: { name: 'x' }, resource: { type: 't', id: 'x' } }],
    ['missing action', { subject: { type: 'user', id: 'a' }, resource: { type: 't', id: 'x' } }],
    ['missing resource', { subject: { type: 'user', id: 'a' }, action: { name: 'x' } }],
    ['action without name', { subject: { type: 'user', id: 'a' }, action: {}, resource: { type: 't', id: 'x' } }],
    ['subject without id', { subject: { type: 'user' }, action: { name: 'x' }, resource: { type: 't', id: 'x' } }],
  ])('400 on %s', (_label, body) => {
    expect(post(deps, AUTHZEN_EVALUATION_PATH, JSON.stringify(body)).status).toBe(400)
  })

  it('404 on an unknown authzen path', () => {
    expect(post(deps, '/access/v1/nope', evaluation('search')).status).toBe(404)
  })

  it('non-object arguments are refused, not coerced', () => {
    const body = JSON.stringify({
      subject: { type: 'user', id: 'a' },
      action: { name: 'search' },
      resource: { type: 't', id: 'search', properties: { arguments: 'rm -rf /' } },
    })
    expect(post(deps, AUTHZEN_EVALUATION_PATH, body).status).toBe(400)
  })
})

describe('protocol details', () => {
  it('echoes X-Request-ID', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('search'), { 'x-request-id': 'req-42' })
    expect(r.headers['x-request-id']).toBe('req-42')
  })

  it('responds with application/json', () => {
    const r = post(deps, AUTHZEN_EVALUATION_PATH, evaluation('search'))
    expect(r.headers['content-type']).toBe('application/json')
  })

  it('405 on a non-POST method (endpoints are POST-only)', () => {
    const res = handleAuthZen(AUTHZEN_EVALUATION_PATH, 'GET', evaluation('search'), {}, deps)
    expect(res.status).toBe(405)
    // A GET carrying a body must not be evaluated.
    expect(() => readFileSync(deps.auditPath, 'utf-8')).toThrow()
  })
})

describe('server routing', () => {
  it('serves AuthZen on /access/v1/evaluation and ext_authz everywhere else', async () => {
    const { createServer } = await import('../src/server.js')
    const server = createServer(deps)
    await new Promise<void>((r) => server.listen(0, r))
    const { port } = server.address() as { port: number }
    try {
      const az = await fetch(`http://127.0.0.1:${port}${AUTHZEN_EVALUATION_PATH}`, {
        method: 'POST',
        body: evaluation('delete_user'),
      })
      // AuthZen deny: HTTP 200 with decision false.
      expect(az.status).toBe(200)
      expect((await az.json()).decision).toBe(false)

      const envoy = await fetch(`http://127.0.0.1:${port}/check`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_user', arguments: {} } }),
      })
      // ext_authz deny: HTTP 403.
      expect(envoy.status).toBe(403)
    } finally {
      server.close()
    }
  })
})

describe('batch evaluations', () => {
  const batch = (evaluations: unknown[], options?: Record<string, unknown>) =>
    JSON.stringify({
      subject: { type: 'user', id: 'alice@example.com' },
      action: { name: 'search' },
      resource: { type: 'mcp_tool', id: 'search' },
      evaluations,
      ...(options ? { options } : {}),
    })

  it('evaluates all items with defaults and per-item overrides', () => {
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, batch([
      {},
      { action: { name: 'delete_user' }, resource: { type: 'mcp_tool', id: 'delete_user' } },
    ]))
    expect(r.status).toBe(200)
    expect(r.json.evaluations).toHaveLength(2)
    expect(r.json.evaluations[0].decision).toBe(true)
    expect(r.json.evaluations[1].decision).toBe(false)
  })

  it('overriding one field on an item inherits the others (no sibling wipe)', () => {
    // Top-level action=delete_user (block). An item that overrides ONLY resource must
    // still inherit the blocked action and deny — proving per-field, not whole-object, merge.
    const body = JSON.stringify({
      subject: { type: 'user', id: 'a' },
      action: { name: 'delete_user' },
      resource: { type: 'mcp_tool', id: 'delete_user' },
      evaluations: [
        { resource: { type: 'mcp_tool', id: 'other' } }, // inherits action delete_user -> deny
        { action: { name: 'search' } }, // inherits subject/resource, overrides action -> allow
      ],
    })
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, body)
    expect(r.json.evaluations[0].decision).toBe(false)
    expect(r.json.evaluations[1].decision).toBe(true)
  })

  it('deny_on_first_deny stops evaluating after the first deny', () => {
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, batch(
      [{ action: { name: 'delete_user' } }, {}],
      { evaluations_semantic: 'deny_on_first_deny' },
    ))
    expect(r.json.evaluations).toHaveLength(1)
    expect(r.json.evaluations[0].decision).toBe(false)
  })

  it('permit_on_first_permit stops evaluating after the first permit', () => {
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, batch(
      [{}, { action: { name: 'delete_user' } }],
      { evaluations_semantic: 'permit_on_first_permit' },
    ))
    expect(r.json.evaluations).toHaveLength(1)
    expect(r.json.evaluations[0].decision).toBe(true)
  })

  it('empty or missing evaluations falls back to a single evaluation of the top-level (spec §)', () => {
    // Spec: absent/empty evaluations behaves as the single Access Evaluation request —
    // evaluate the top-level subject/action/resource once and return the SINGLE shape.
    const body = JSON.stringify({
      subject: { type: 'user', id: 'a' },
      action: { name: 'delete_user' },
      resource: { type: 'mcp_tool', id: 'delete_user' },
      evaluations: [],
    })
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, body)
    expect(r.status).toBe(200)
    expect(r.json.decision).toBe(false) // top-level action delete_user is blocked
    expect(r.json.evaluations).toBeUndefined()

    // And with evaluations absent entirely.
    const noKey = JSON.stringify({
      subject: { type: 'user', id: 'a' },
      action: { name: 'search' },
      resource: { type: 'mcp_tool', id: 'search' },
    })
    const r2 = post(deps, AUTHZEN_EVALUATIONS_PATH, noKey)
    expect(r2.json.decision).toBe(true)
    expect(r2.json.evaluations).toBeUndefined()
  })

  it('400 when evaluations is absent AND the top-level is not a valid evaluation', () => {
    const body = JSON.stringify({ subject: { type: 'user', id: 'a' } }) // no action/resource
    expect(post(deps, AUTHZEN_EVALUATIONS_PATH, body).status).toBe(400)
  })

  it('400 (whole batch) when any item is malformed after default-merge (MUST bad-request)', () => {
    // Spec: an omitted required attribute MUST be a Bad Request, not a soft deny.
    const body = JSON.stringify({
      subject: { type: 'user', id: 'a' },
      // no top-level action, so an item without action cannot inherit one
      resource: { type: 'mcp_tool', id: 'search' },
      evaluations: [{ action: { name: 'search' } }, { resource: { type: 'mcp_tool', id: 'x' } }],
    })
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, body)
    expect(r.status).toBe(400)
    // Rejected before any side effect: no receipts written.
    expect(() => readFileSync(deps.auditPath, 'utf-8')).toThrow()
  })

  it('400 when the batch exceeds the size cap (no receipt/hold write amplification)', () => {
    const r = post(deps, AUTHZEN_EVALUATIONS_PATH, batch(Array.from({ length: 65 }, () => ({}))))
    expect(r.status).toBe(400)
    // Nothing was evaluated: no receipts were minted for the oversized batch.
    expect(() => readFileSync(deps.auditPath, 'utf-8')).toThrow()
  })
})
