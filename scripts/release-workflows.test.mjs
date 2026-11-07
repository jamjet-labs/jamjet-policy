// Checks the npm release workflows before anything gets tagged.
//
// Every public package under packages/ must have exactly one release workflow,
// triggered by '<package dir>-v*' tags, that runs three gates before it
// installs or publishes:
//   - the tag version must equal package.json's version, character for character
//   - the tagged commit must be on main (a tag can point at any commit)
//   - every dependency range must be a plain semver range or dist-tag; npm
//     publish ships workspace:, file:, link:, catalog: and git specifiers
//     verbatim, and consumers can't resolve them
// No step in a publishing job may be conditional or allowed to fail, or a
// gate (or the tests) could be skipped on the way to publish. The gate
// scripts are pulled out of the YAML and run against fixtures, so a gate that
// is present but no longer refuses anything fails too.
//
// Run with: node --test scripts/release-workflows.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')

const TAG_GATE = 'Gate tag against package.json version'
const MAIN_GATE = 'Gate tag commit on main'
const DEPS_GATE = 'Gate dependencies on published versions'
const GATES = [TAG_GATE, MAIN_GATE, DEPS_GATE]
const PUBLISH = /\b(npm(@\S+)?|pnpm)\s+publish\b/

function publicPackages() {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'packages', d.name, 'package.json')))
    .map((d) => ({
      dir: d.name,
      manifest: JSON.parse(readFileSync(join(ROOT, 'packages', d.name, 'package.json'), 'utf-8')),
    }))
    .filter((p) => p.manifest.private !== true)
}

function publishJobs() {
  const out = []
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const doc = parse(readFileSync(join(WORKFLOWS, file), 'utf-8'))
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      const steps = job.steps ?? []
      const publishAt = steps.findIndex((s) => typeof s.run === 'string' && PUBLISH.test(s.run))
      if (publishAt < 0) continue
      out.push({
        file,
        doc,
        jobName,
        job,
        steps,
        publishAt,
        workingDirectory: job.defaults?.run?.['working-directory'],
      })
    }
  }
  return out
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf-8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * Run the main-branch gate in a clone whose origin has `main` at commit A,
 * with a local-only commit B on a side branch. Returns the exit status for
 * GITHUB_SHA set to each commit.
 */
function runMainGate(script) {
  const dir = mkdtempSync(join(tmpdir(), 'release-main-gate-'))
  try {
    const origin = join(dir, 'origin.git')
    const work = join(dir, 'work')
    git(dir, 'init', '-q', '--bare', origin)
    git(dir, 'init', '-q', work)
    git(work, 'commit', '-q', '--allow-empty', '-m', 'A')
    const a = git(work, 'rev-parse', 'HEAD')
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    git(work, 'checkout', '-q', '-b', 'side')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'B')
    const b = git(work, 'rev-parse', 'HEAD')
    const status = (sha) =>
      spawnSync('bash', ['-e', '-c', script], {
        cwd: work,
        env: { PATH: process.env.PATH ?? '', GITHUB_SHA: sha },
        encoding: 'utf-8',
      }).status
    return { onMain: status(a), offMain: status(b), unknown: status('0'.repeat(40)) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run a gate's shell script in a temp dir holding the given package.json. */
function runGate(script, manifest, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const r = spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf-8',
    })
    return r.status
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const jobs = publishJobs()

for (const pkg of publicPackages()) {
  test(`${pkg.manifest.name} has exactly one release workflow`, () => {
    const matching = jobs.filter((j) => j.workingDirectory === `packages/${pkg.dir}`)
    assert.equal(
      matching.length,
      1,
      `expected one publishing job with working-directory packages/${pkg.dir}, found ${matching.map((j) => j.file).join(', ') || 'none'}`,
    )
  })
}

for (const j of jobs) {
  const dir = (j.workingDirectory ?? '').replace(/^packages\//, '')
  const prefix = `${dir}-v`

  test(`${j.file}: publishes a package from packages/`, () => {
    assert.match(j.workingDirectory ?? '', /^packages\/[^/]+$/)
    assert.ok(existsSync(join(ROOT, j.workingDirectory, 'package.json')))
  })

  test(`${j.file}: runs only on ${prefix}* tags`, () => {
    assert.deepEqual(Object.keys(j.doc.on ?? {}), ['push'])
    assert.equal(j.doc.on.push.branches, undefined)
    assert.deepEqual(j.doc.on.push.tags, [`${prefix}*`])
  })

  test(`${j.file}: publishes with provenance under OIDC`, () => {
    assert.match(j.steps[j.publishAt].run, /--provenance\b/)
    assert.equal(j.job.permissions?.['id-token'], 'write')
  })

  const install = j.steps.findIndex((s) => s.name === 'Install')
  const tagGate = j.steps.findIndex((s) => s.name === TAG_GATE)
  const depsGate = j.steps.findIndex((s) => s.name === DEPS_GATE)

  test(`${j.file}: runs every gate before Install and publish`, () => {
    assert.ok(install >= 0, 'missing step "Install"')
    for (const gate of GATES) {
      const at = j.steps.findIndex((s) => s.name === gate)
      assert.ok(at >= 0, `missing step "${gate}"`)
      assert.ok(at < install, `"${gate}" must run before Install`)
      assert.ok(at < j.publishAt, `"${gate}" must run before publish`)
    }
  })

  test(`${j.file}: no step can be skipped or allowed to fail`, () => {
    assert.equal(j.job['continue-on-error'], undefined, 'job has continue-on-error')
    for (const [i, step] of j.steps.entries()) {
      const label = step.name ?? step.uses ?? `step ${i}`
      assert.equal(step.if, undefined, `"${label}" has an if:`)
      assert.equal(step['continue-on-error'], undefined, `"${label}" has continue-on-error`)
    }
  })

  test(`${j.file}: checks out full history so the main gate can see main`, () => {
    const checkout = j.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
    assert.ok(checkout, 'missing actions/checkout')
    assert.equal(checkout.with?.['fetch-depth'], 0)
  })

  test(`${j.file}: main gate refuses a tagged commit that is not on main`, () => {
    const script = j.steps.find((s) => s.name === MAIN_GATE)?.run
    assert.ok(script, `missing step "${MAIN_GATE}"`)
    const r = runMainGate(script)
    assert.equal(r.onMain, 0, 'a commit on main must pass')
    assert.notEqual(r.offMain, 0, 'a commit only on another branch must fail')
    assert.notEqual(r.unknown, 0, 'an unknown commit must fail')
  })

  test(`${j.file}: tag gate refuses a tag that does not match package.json`, () => {
    const script = j.steps[tagGate]?.run
    assert.ok(script, `missing step "${TAG_GATE}"`)
    const manifest = { name: 'x', version: '1.2.3' }
    assert.equal(runGate(script, manifest, { GITHUB_REF_NAME: `${prefix}1.2.3` }), 0, 'matching tag must pass')
    assert.notEqual(runGate(script, manifest, { GITHUB_REF_NAME: `${prefix}1.2.4` }), 0, 'other version must fail')
    assert.notEqual(runGate(script, manifest, { GITHUB_REF_NAME: `${prefix}v1.2.3` }), 0, 'unnormalized tag must fail')
    assert.notEqual(runGate(script, manifest, { GITHUB_REF_NAME: `other-v1.2.3` }), 0, 'other prefix must fail')
  })

  test(`${j.file}: dependency gate accepts only published ranges`, () => {
    const script = j.steps[depsGate]?.run
    assert.ok(script, `missing step "${DEPS_GATE}"`)
    const good = ['^1.0.0', '~1.2', '>=1 <2', '1.x', '*', 'latest', '1.0.0 - 2.0.0', '^1 || ^2', '1.0.0-rc.1']
    const clean = {
      name: 'x',
      version: '1.0.0',
      dependencies: Object.fromEntries(good.map((r, i) => [`d${i}`, r])),
      devDependencies: { local: 'workspace:*', tool: 'file:../tool' },
    }
    assert.equal(runGate(script, clean), 0, 'semver ranges and dist-tags (and anything in devDependencies) must pass')
    const bad = [
      'workspace:*',
      'workspace:^',
      'file:../x',
      'link:../x',
      'catalog:',
      'catalog:default',
      'git+https://github.com/a/b.git',
      'git://github.com/a/b.git',
      'git+ssh://git@github.com/a/b.git',
      'github:a/b',
      'a/b',
      'https://example.com/x.tgz',
      'npm:@jamjet/cloud@workspace:*',
      '',
    ]
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const range of bad) {
        const m = { name: 'x', version: '1.0.0', [field]: { a: '^1.0.0', b: range } }
        assert.notEqual(runGate(script, m), 0, `${JSON.stringify(range)} in ${field} must fail`)
      }
    }
  })
}
