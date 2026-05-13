import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/cloud/config.js'

describe('loadConfig', () => {
  const PROJECT_UUID_A = '11111111-1111-1111-1111-111111111111'
  const PROJECT_UUID_B = '22222222-2222-2222-2222-222222222222'
  const envSnapshot = { ...process.env }
  let tmpDir: string
  let cfgPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jamjet-config-test-'))
    mkdirSync(join(tmpDir, '.jamjet'), { recursive: true })
    cfgPath = join(tmpDir, '.jamjet', 'config.yaml')
    // Wipe overrides that may have leaked from the host shell.
    delete process.env.JAMJET_CLOUD_TOKEN
    delete process.env.JAMJET_PROJECT
    delete process.env.JAMJET_API_BASE
    delete process.env.JAMJET_ARGS_REDACTION
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    process.env = { ...envSnapshot }
  })

  function writeYaml(body: string): void {
    writeFileSync(cfgPath, body)
    // Sanity check — fail loudly if the test fixture itself didn't land.
    if (!existsSync(cfgPath)) throw new Error(`fixture not written: ${cfgPath}`)
  }

  it('throws a clear error when neither file nor env vars are present', () => {
    expect(() => loadConfig({ path: cfgPath })).toThrow(/No cloud config found/i)
  })

  it('reads project_id and api_key from the config file and applies defaults', () => {
    writeYaml(`cloud:\n  project_id: ${PROJECT_UUID_A}\n  api_key: jj_abc123\n`)
    const cfg = loadConfig({ path: cfgPath })
    expect(cfg.cloud.project_id).toBe(PROJECT_UUID_A)
    expect(cfg.cloud.api_key).toBe('jj_abc123')
    expect(cfg.cloud.api_base).toBe('https://api.jamjet.dev')
    expect(cfg.cloud.args_redaction).toBe('full')
    expect(cfg.cloud.poll_interval_seconds).toBe(2)
  })

  it('env vars override file config', () => {
    writeYaml(`cloud:\n  project_id: ${PROJECT_UUID_A}\n  api_key: jj_fromfile\n`)
    process.env.JAMJET_CLOUD_TOKEN = 'jj_fromenv'
    process.env.JAMJET_API_BASE = 'https://api-preview.jamjet.dev'

    const cfg = loadConfig({ path: cfgPath })
    expect(cfg.cloud.api_key).toBe('jj_fromenv')
    expect(cfg.cloud.api_base).toBe('https://api-preview.jamjet.dev')
  })

  it('env-only config (no file) works for CI / Docker', () => {
    process.env.JAMJET_CLOUD_TOKEN = 'jj_cikey'
    process.env.JAMJET_PROJECT = PROJECT_UUID_B

    const cfg = loadConfig({ path: cfgPath })
    expect(cfg.cloud.api_key).toBe('jj_cikey')
    expect(cfg.cloud.project_id).toBe(PROJECT_UUID_B)
  })

  it('rejects invalid project_id (not a uuid)', () => {
    writeYaml('cloud:\n  project_id: not-a-uuid\n  api_key: jj_x\n')
    expect(() => loadConfig({ path: cfgPath })).toThrow(/uuid/i)
  })

  it('rejects api_key that does not start with jj_', () => {
    writeYaml(`cloud:\n  project_id: ${PROJECT_UUID_A}\n  api_key: sk-openai-secret\n`)
    expect(() => loadConfig({ path: cfgPath })).toThrow(/jj_/i)
  })
})
