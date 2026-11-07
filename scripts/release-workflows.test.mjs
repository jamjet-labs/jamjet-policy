// Checks the npm release workflows before anything gets tagged.
//
// Every public package under packages/ must have exactly one release workflow,
// triggered by '<package dir>-v*' tags, that runs two gates before it installs
// or publishes:
//   - the tag version must equal package.json's version, character for character
//   - no dependency range may use the workspace: protocol, which npm publish
//     ships verbatim and no consumer can resolve
// The gate scripts are pulled out of the YAML and run against fixture
// manifests, so a gate that is present but no longer refuses anything fails too.
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
const WORKSPACE_GATE = 'Gate against workspace protocol in dependencies'
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
  const wsGate = j.steps.findIndex((s) => s.name === WORKSPACE_GATE)

  test(`${j.file}: runs both gates before Install and publish`, () => {
    assert.ok(tagGate >= 0, `missing step "${TAG_GATE}"`)
    assert.ok(wsGate >= 0, `missing step "${WORKSPACE_GATE}"`)
    assert.ok(install >= 0, 'missing step "Install"')
    assert.ok(tagGate < install && wsGate < install, 'gates must run before Install')
    assert.ok(tagGate < j.publishAt && wsGate < j.publishAt, 'gates must run before publish')
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

  test(`${j.file}: workspace gate refuses workspace: ranges`, () => {
    const script = j.steps[wsGate]?.run
    assert.ok(script, `missing step "${WORKSPACE_GATE}"`)
    const clean = { name: 'x', version: '1.0.0', dependencies: { a: '^1.0.0' }, devDependencies: { b: 'workspace:*' } }
    assert.equal(runGate(script, clean), 0, 'published ranges (and workspace: devDependencies) must pass')
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const bad = { name: 'x', version: '1.0.0', [field]: { a: '^1.0.0', b: 'workspace:*' } }
      assert.notEqual(runGate(script, bad), 0, `workspace: in ${field} must fail`)
    }
  })
}
