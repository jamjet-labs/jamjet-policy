// End-to-end tests against the built hook (dist/bin.js), the way Claude Code
// runs it: JSON on stdin, decision in the exit code and stdout.
//
// Claude Code reads exit 2 from a PreToolUse hook as "block". Exit 0 lets the
// call go ahead unless stdout carries a JSON decision. Any other exit code is
// a non-blocking error and the tool runs. So every refusal here must be exit 2.
//
// Run `pnpm build` before `pnpm test`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const EXAMPLE_POLICY = fileURLToPath(new URL('../../../examples/claude-code-policy/policy.yaml', import.meta.url))
const BIN = join(DIST, 'bin.js')

const BLOCK_DELETE = `version: 1
rules:
  - { match: "*delete*", action: block }
  - { match: "WebFetch", action: require_approval }
  - { match: "WebSearch", action: audit }
`
const ALLOW_ALL = `version: 1
rules:
  - { match: "*", action: allow }
`

let root: string
let home: string
let project: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jamjet-hook-'))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(join(home, '.jamjet'), { recursive: true })
  mkdirSync(project, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeHomePolicy(body: string): void {
  writeFileSync(join(home, '.jamjet', 'policy.yaml'), body)
}

function toolCall(tool_name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name,
    tool_input: {},
    ...extra,
  })
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runHook(opts: {
  stdin: string
  args?: string[]
  env?: Record<string, string>
  bin?: string
  timeoutMs?: number
}): RunResult {
  const r = spawnSync(process.execPath, [opts.bin ?? BIN, ...(opts.args ?? [])], {
    input: opts.stdin,
    cwd: project,
    // A clean environment: nothing from the developer's shell (JAMJET_*,
    // cloud tokens) leaks into the run.
    env: { PATH: process.env.PATH ?? '', HOME: home, ...(opts.env ?? {}) },
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 20_000,
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function auditLines(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return []
  const out: Array<Record<string, unknown>> = []
  for (const day of readdirSync(dir)) {
    const file = join(dir, day, 'claude-code-hook.jsonl')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return out
}

describe('decisions', () => {
  it('block exits 2 with the rule on stderr and nothing on stdout', () => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('JamJet policy: BLOCKED (rule: *delete*)')
    expect(r.stdout).toBe('')
  })

  it('allow exits 0 with no output', () => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('audit exits 0 with no decision on stdout', () => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('WebSearch') })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('require_approval exits 0 and asks Claude Code to prompt the user', () => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('WebFetch') })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'JamJet policy: approval required (rule: WebFetch)',
      },
    })
  })

  it.each(['acceptEdits', 'auto', 'dontAsk'])('require_approval asks in %s mode', (mode) => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('WebFetch', { permission_mode: mode }) })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
  })

  // Nothing documents that a hook's "ask" reaches a person in plan or
  // bypassPermissions mode. Block there, as for modes the hook does not know.
  it.each(['plan', 'bypassPermissions', 'someFutureMode'])('require_approval blocks in %s mode', (mode) => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('WebFetch', { permission_mode: mode }) })
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('approval required')
  })

  it('require_approval blocks when permission_mode is missing', () => {
    writeHomePolicy(BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('WebFetch', { permission_mode: undefined }) })
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
  })

  it('writes the decision and what the hook returned to the audit log', () => {
    writeHomePolicy(BLOCK_DELETE)
    runHook({ stdin: toolCall('mcp__db__delete_all', { mcp_server: { name: 'db', source: 'project' } }) })
    runHook({ stdin: toolCall('WebFetch') })
    runHook({ stdin: toolCall('WebFetch', { permission_mode: 'bypassPermissions' }) })
    runHook({ stdin: toolCall('Read') })
    const events = auditLines(join(home, '.jamjet', 'audit'))
    expect(events.map((e) => [e.tool, e.server, e.decision, e.hook_decision, e.executed])).toEqual([
      ['delete_all', 'db', 'BLOCKED', 'block', false],
      ['WebFetch', null, 'WAITING_FOR_APPROVAL', 'ask', false],
      ['WebFetch', null, 'WAITING_FOR_APPROVAL', 'block', false],
      ['Read', null, 'ALLOWED', 'allow', true],
    ])
    expect(events[0]!.server_source).toBe('project')
  })
})

describe('fails closed on errors', () => {
  it('blocks when a rule has an unknown action (typo)', () => {
    writeHomePolicy(`version: 1
rules:
  - { match: "*delete*", action: blok }
`)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown action: blok')
  })

  it('blocks when there is no policy file', () => {
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/policy/i)
  })

  it('blocks when the policy is not valid YAML', () => {
    writeHomePolicy('version: 1\nrules: [ { match: "*", action: allow\n')
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
  })

  it('blocks when the policy version is unsupported', () => {
    writeHomePolicy('version: 2\nrules: []\n')
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unsupported policy version')
  })

  it('blocks when --policy points at a missing file', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: toolCall('Read'), args: ['--policy', join(root, 'nope.yaml')] })
    expect(r.code).toBe(2)
  })

  it('blocks when --policy has no value', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: toolCall('Read'), args: ['--policy'] })
    expect(r.code).toBe(2)
  })

  it('blocks on an unknown argument instead of ignoring it', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: toolCall('Read'), args: ['--polcy', join(root, 'x.yaml')] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown argument: --polcy')
  })

  it('blocks when stdin is not JSON', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: 'not json' })
    expect(r.code).toBe(2)
  })

  it('blocks when stdin has no tool_name', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: JSON.stringify({ tool_input: {} }) })
    expect(r.code).toBe(2)
  })

  it('blocks when wired to an event other than PreToolUse', () => {
    writeHomePolicy(ALLOW_ALL)
    const r = runHook({ stdin: toolCall('Read', { hook_event_name: 'PostToolUse' }) })
    expect(r.code).toBe(2)
  })

  it('blocks when its own dependencies cannot be loaded', () => {
    // A copy of dist/ with no node_modules next to it: the @jamjet/cloud
    // import fails. Node's default for that is exit 1, which lets the tool run.
    writeHomePolicy(ALLOW_ALL)
    const broken = join(root, 'broken')
    mkdirSync(broken)
    for (const f of readdirSync(DIST)) {
      if (f.endsWith('.js')) copyFileSync(join(DIST, f), join(broken, f))
    }
    writeFileSync(join(broken, 'package.json'), '{"type":"module"}')
    const r = runHook({ stdin: toolCall('Read'), bin: join(broken, 'bin.js') })
    expect(r.code).toBe(2)
  })
})

describe('audit failures', () => {
  function policyWithBrokenAudit(rules: string): string {
    // The audit destination sits under a regular file, so mkdir fails.
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    return `version: 1\naudit:\n  destination: ${JSON.stringify(join(blocker, 'audit'))}\nrules:\n${rules}`
  }

  it('a block still blocks when the audit write fails', () => {
    writeHomePolicy(policyWithBrokenAudit('  - { match: "*delete*", action: block }\n'))
    const r = runHook({ stdin: toolCall('mcp__db__delete_all') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })

  it('an allowed call is blocked when the audit write fails', () => {
    writeHomePolicy(policyWithBrokenAudit('  - { match: "*delete*", action: block }\n'))
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('audit')
  })

  it('an approval is blocked, not asked, when the audit write fails', () => {
    writeHomePolicy(policyWithBrokenAudit('  - { match: "WebFetch", action: require_approval }\n'))
    const r = runHook({ stdin: toolCall('WebFetch') })
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
  })

  it('--allow-audit-failure lets an allowed call through with a warning', () => {
    writeHomePolicy(policyWithBrokenAudit('  - { match: "*delete*", action: block }\n'))
    const r = runHook({ stdin: toolCall('Read'), args: ['--allow-audit-failure'] })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('audit')
  })

  it('--allow-audit-failure never turns a block into an allow', () => {
    writeHomePolicy(policyWithBrokenAudit('  - { match: "*delete*", action: block }\n'))
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), args: ['--allow-audit-failure'] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })
})

describe('policy file selection', () => {
  it('ignores a policy.yaml in the working directory', () => {
    writeHomePolicy(BLOCK_DELETE)
    writeFileSync(join(project, 'policy.yaml'), ALLOW_ALL)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })

  it('does not fall back to a working-directory policy when the home policy is missing', () => {
    writeFileSync(join(project, 'policy.yaml'), ALLOW_ALL)
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
  })

  it('--policy wins over JAMJET_POLICY_FILE and the home policy', () => {
    writeHomePolicy(ALLOW_ALL)
    const flagged = join(root, 'flagged.yaml')
    writeFileSync(flagged, BLOCK_DELETE)
    const r = runHook({
      stdin: toolCall('mcp__db__delete_all'),
      args: ['--policy', flagged],
      env: { JAMJET_POLICY_FILE: join(root, 'missing.yaml') },
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })

  it('JAMJET_POLICY_FILE wins over the home policy', () => {
    writeHomePolicy(ALLOW_ALL)
    const fromEnv = join(root, 'env.yaml')
    writeFileSync(fromEnv, BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), env: { JAMJET_POLICY_FILE: fromEnv } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })

  it('JAMJET_POLICY is accepted the same way', () => {
    writeHomePolicy(ALLOW_ALL)
    const fromEnv = join(root, 'env.yaml')
    writeFileSync(fromEnv, BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), env: { JAMJET_POLICY: fromEnv } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })

  it('blocks when JAMJET_POLICY and JAMJET_POLICY_FILE disagree', () => {
    writeHomePolicy(ALLOW_ALL)
    writeFileSync(join(root, 'a.yaml'), ALLOW_ALL)
    writeFileSync(join(root, 'b.yaml'), ALLOW_ALL)
    const r = runHook({
      stdin: toolCall('Read'),
      env: { JAMJET_POLICY_FILE: join(root, 'a.yaml'), JAMJET_POLICY: join(root, 'b.yaml') },
    })
    expect(r.code).toBe(2)
  })

  it('expands a leading ~ in --policy (exec-form hooks get no shell expansion)', () => {
    writeFileSync(join(home, 'custom.yaml'), BLOCK_DELETE)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), args: ['--policy', '~/custom.yaml'] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
  })
})

describe('nothing resolves against the project directory', () => {
  beforeEach(() => {
    writeFileSync(join(project, 'policy.yaml'), ALLOW_ALL)
    mkdirSync(join(project, '.jamjet'), { recursive: true })
    writeFileSync(join(project, '.jamjet', 'policy.yaml'), ALLOW_ALL)
    writeHomePolicy(BLOCK_DELETE)
  })

  it('refuses a relative --policy', () => {
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), args: ['--policy', 'policy.yaml'] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('relative path')
  })

  it('refuses a relative JAMJET_POLICY_FILE', () => {
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), env: { JAMJET_POLICY_FILE: 'policy.yaml' } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('relative path')
  })

  it.each(['', '.'])('refuses HOME=%j instead of reading .jamjet/ under the project', (badHome) => {
    // The project's policy sets an absolute audit destination, so only the
    // HOME check stands between it and being loaded.
    const elsewhere = join(root, 'repo-chosen-audit')
    writeFileSync(join(project, '.jamjet', 'policy.yaml'), `${ALLOW_ALL}audit:\n  destination: ${JSON.stringify(elsewhere)}\n`)
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), env: { HOME: badHome } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('home directory')
    expect(existsSync(elsewhere)).toBe(false)
  })

  it('refuses a relative audit.destination', () => {
    writeHomePolicy('version: 1\naudit:\n  destination: audit-logs\nrules: []\n')
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(existsSync(join(project, 'audit-logs'))).toBe(false)
  })
})

describe('policy checks beyond the shared schema', () => {
  it('refuses a policy path that is not a regular file (a FIFO would hang until the hook times out)', () => {
    writeHomePolicy(ALLOW_ALL)
    const fifo = join(root, 'policy.fifo')
    execFileSync('mkfifo', [fifo])
    const r = runHook({ stdin: toolCall('Read'), args: ['--policy', fifo] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('not a regular file')
  })

  it.each([
    ['Bash(rm *)', 'characters no Claude Code tool name contains'],
    ['shell.exec', 'characters no Claude Code tool name contains'],
    ['Bash ', 'characters no Claude Code tool name contains'],
    ['bash', 'differs in case from the built-in tool Bash'],
    ['x'.repeat(129), 'more than 128 characters'],
    ['bash*', 'differs in case from the built-in tool Bash'],
    ['webFetch?', 'differs in case from the built-in tool WebFetch'],
  ])('refuses a pattern that can never match a Claude Code tool name: %j', (pattern, why) => {
    writeHomePolicy(`version: 1\nrules:\n  - { match: ${JSON.stringify(pattern)}, action: block }\n`)
    const r = runHook({ stdin: toolCall('Bash') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(why)
  })

  it.each([
    ['default: block\n', 'unknown key: default'],
    ['budgets: { max_tool_calls: 5 }\n', 'unknown key: budgets'],
    ['defaults: {}\n', 'unknown key: defaults'],
  ])('refuses an unknown top-level key: %j', (extra, why) => {
    writeHomePolicy(`version: 1\n${extra}rules:\n  - { match: "Read", action: allow }\n`)
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(why)
  })

  it.each([
    ['command: "git *"', 'unknown key: command'],
    ['approval_timeout: 30', 'unknown key: approval_timeout'],
  ])('refuses an unknown rule key: %s', (extra, why) => {
    writeHomePolicy(`version: 1\nrules:\n  - { match: "Bash", action: allow, ${extra} }\n`)
    const r = runHook({ stdin: toolCall('Bash') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(why)
  })

  it('refuses a tool_name Claude Code could not have sent', () => {
    writeHomePolicy(ALLOW_ALL)
    expect(runHook({ stdin: toolCall('database.read') }).code).toBe(2)
    expect(runHook({ stdin: toolCall('Read\nBash') }).code).toBe(2)
    expect(runHook({ stdin: toolCall('x'.repeat(129)) }).code).toBe(2)
  })

  it('a pathological pattern does not stall the hook', () => {
    // As a regex this backtracks for many seconds on a 56-character name.
    writeHomePolicy(`version: 1\nrules:\n  - { match: "${'*a'.repeat(8)}*b", action: block }\n`)
    const started = Date.now()
    const r = runHook({ stdin: toolCall('a'.repeat(56)), timeoutMs: 8000 })
    expect(r.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('refuses an empty match', () => {
    writeHomePolicy('version: 1\nrules:\n  - { match: "", action: block }\n')
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('it is empty')
  })

  it.each([
    ['a string', 'audit: /tmp/x\n'],
    ['an unknown key', 'audit:\n  destnation: /tmp/x\n'],
    ['a non-boolean rotate_daily', 'audit:\n  rotate_daily: "no"\n'],
  ])('refuses an audit block with %s', (_label, auditYaml) => {
    writeHomePolicy(`version: 1\n${auditYaml}rules: []\n`)
    expect(runHook({ stdin: toolCall('Read') }).code).toBe(2)
  })
})

describe('stdout carries only the decision', () => {
  it('keeps dependency logging off stdout so the ask stays one JSON object', () => {
    writeHomePolicy(BLOCK_DELETE)
    // yaml prints its token stream to stdout when LOG_TOKENS is set.
    const r = runHook({ stdin: toolCall('WebFetch'), env: { LOG_TOKENS: '1' } })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
  })
})

describe('examples/claude-code-policy', () => {
  it.each([
    ['mcp__postgres__delete_rows', 'block'],
    ['mcp__postgres__drop_table', 'block'],
    ['Bash', 'ask'],
    ['PowerShell', 'ask'],
    ['Monitor', 'ask'],
    ['Write', 'ask'],
    ['mcp__github__merge_pull_request', 'ask'],
    ['WebFetch', 'allow'],
    ['Read', 'allow'],
  ])('%s -> %s, as the example README says', (tool, expected) => {
    const r = runHook({ stdin: toolCall(tool), args: ['--policy', EXAMPLE_POLICY] })
    if (expected === 'block') {
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('BLOCKED (rule:')
    } else if (expected === 'ask') {
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    } else {
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
})

describe('MCP tool names', () => {
  it('an allow written for a built-in does not allow an MCP tool with the same name', () => {
    writeHomePolicy('version: 1\nrules:\n  - { match: "Read", action: allow }\n  - { match: "*", action: block }\n')
    expect(runHook({ stdin: toolCall('Read') }).code).toBe(0)
    const r = runHook({ stdin: toolCall('mcp__evil__Read', { mcp_server: { name: 'evil', source: 'project' } }) })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *)')
  })

  it('mcp__<server>__* patterns match that server by full name', () => {
    writeHomePolicy('version: 1\nrules:\n  - { match: "mcp__github__*", action: allow }\n  - { match: "*", action: block }\n')
    expect(runHook({ stdin: toolCall('mcp__github__create_issue') }).code).toBe(0)
    expect(runHook({ stdin: toolCall('mcp__gitlab__create_issue') }).code).toBe(2)
  })
})

describe('audit file safety', () => {
  function today(offsetDays = 0): string {
    return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
  }

  // Put the given kind of non-file at today's (and tomorrow's, in case the
  // date turns over mid-test) audit file path.
  function plantAtAuditFile(make: (path: string) => void): void {
    for (const day of [today(), today(1)]) {
      const dir = join(home, '.jamjet', 'audit', day)
      mkdirSync(dir, { recursive: true })
      make(join(dir, 'claude-code-hook.jsonl'))
    }
  }

  it('a FIFO at the audit file does not hold up a block', () => {
    writeHomePolicy(BLOCK_DELETE)
    plantAtAuditFile((p) => execFileSync('mkfifo', [p]))
    const started = Date.now()
    const r = runHook({ stdin: toolCall('mcp__db__delete_all'), timeoutMs: 8000 })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BLOCKED (rule: *delete*)')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a FIFO at the audit file blocks an allowed call instead of hanging', () => {
    writeHomePolicy(BLOCK_DELETE)
    plantAtAuditFile((p) => execFileSync('mkfifo', [p]))
    const started = Date.now()
    const r = runHook({ stdin: toolCall('Read'), timeoutMs: 8000 })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('audit')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a FIFO with a reader attached is still refused (not a regular file)', () => {
    writeHomePolicy(BLOCK_DELETE)
    const fifos: string[] = []
    plantAtAuditFile((p) => {
      execFileSync('mkfifo', [p])
      fifos.push(p)
    })
    // Hold the read end open so a non-blocking open for writing succeeds.
    const fds = fifos.map((p) => openSync(p, constants.O_RDONLY | constants.O_NONBLOCK))
    try {
      const r = runHook({ stdin: toolCall('Read'), timeoutMs: 8000 })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('not a regular file')
    } finally {
      for (const fd of fds) closeSync(fd)
    }
  })

  it('a symlinked audit file is refused and its target is left alone', () => {
    writeHomePolicy(BLOCK_DELETE)
    const victim = join(root, 'victim-rc')
    writeFileSync(victim, 'original\n')
    plantAtAuditFile((p) => symlinkSync(victim, p))
    const r = runHook({ stdin: toolCall('Read') })
    expect(r.code).toBe(2)
    expect(readFileSync(victim, 'utf-8')).toBe('original\n')
  })

  it('creates audit directories 0700 and files 0600', () => {
    writeHomePolicy(BLOCK_DELETE)
    expect(runHook({ stdin: toolCall('Read') }).code).toBe(0)
    const dayDir = join(home, '.jamjet', 'audit', readdirSync(join(home, '.jamjet', 'audit'))[0]!)
    expect(statSync(dayDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dayDir, 'claude-code-hook.jsonl')).mode & 0o777).toBe(0o600)
  })
})

describe('shell tools in the example policy', () => {
  // Shell commands run through Bash, PowerShell and Monitor. In
  // bypassPermissions an approval rule blocks, so all three must be covered.
  it.each(['Bash', 'PowerShell', 'Monitor'])('%s is blocked in bypassPermissions mode', (tool) => {
    const r = runHook({ stdin: toolCall(tool, { permission_mode: 'bypassPermissions' }), args: ['--policy', EXAMPLE_POLICY] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('approval required')
  })
})

describe('MCP server names with __ or edge underscores', () => {
  const POLICY = 'version: 1\nrules:\n  - { match: "delete_rows", action: block }\n  - { match: "merge_pull_request", action: require_approval }\n'
  const cases: Array<[string, string, 'block' | 'ask']> = [
    ['mcp__pg___delete_rows', 'pg_', 'block'],
    ['mcp___pg__delete_rows', '_pg', 'block'],
    ['mcp__a__b__delete_rows', 'a__b', 'block'],
    ['mcp__gh__x__merge_pull_request', 'gh__x', 'ask'],
  ]
  function expectOutcome(r: RunResult, expected: 'block' | 'ask'): void {
    if (expected === 'block') {
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('BLOCKED (rule:')
    } else {
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    }
  }

  it.each(cases)('%s without mcp_server -> %s', (tool, _server, expected) => {
    writeHomePolicy(POLICY)
    expectOutcome(runHook({ stdin: toolCall(tool) }), expected)
  })

  it.each(cases)('%s with mcp_server.name %j -> %s', (tool, server, expected) => {
    writeHomePolicy(POLICY)
    expectOutcome(runHook({ stdin: toolCall(tool, { mcp_server: { name: server, source: 'project' } }) }), expected)
  })
})

describe('accepted patterns', () => {
  it.each(['*delete*', 'list*', 'mcp__*__read*', 'Read*', 'Bash'])('%j is accepted', (pattern) => {
    writeHomePolicy(`version: 1\nrules:\n  - { match: ${JSON.stringify(pattern)}, action: audit }\n`)
    expect(runHook({ stdin: toolCall('Glob') }).code).toBe(0)
  })
})
