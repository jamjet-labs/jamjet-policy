// `jamjet cloud link` — device-auth flow.
//
// 1. POST /v1/cli/device-code with client + version → server mints a
//    user_code + device_code + verification_uri.
// 2. Render user_code and verification_uri to the terminal; the user opens
//    the URL in a browser (already logged into the dashboard) and pastes
//    the user_code to authorize this device against a chosen project.
// 3. We poll POST /v1/cli/token { device_code } every `interval` seconds:
//      200  → returns api_key + project_id; write to ~/.jamjet/config.yaml
//      401  → authorization_pending; keep polling
//      403  → user denied → abort
//      400/404 → device_code expired or unknown → abort
//      timeout → give up after `expires_in`
// 4. Save the returned key to config.yaml (mode 0600 — secrets file).
//
// The B1 contract pairs the device_code with the eventual project_id; we
// can't pick the project here.
import { request } from 'undici'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { parse as fromYaml, stringify as toYaml } from 'yaml'
import { configPath } from './config.js'

export interface LinkOptions {
  apiBase?: string
  client?: string
  version?: string
  pollIntervalMs?: number
  timeoutMs?: number
  /** Override stdout for tests. */
  stdout?: (s: string) => void
  /** Override config write path for tests. */
  configFile?: string
}

interface DeviceCodeResp {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface TokenResp {
  api_key: string
  project_id: string
  project_name: string
}

export async function cloudLink(opts: LinkOptions = {}): Promise<TokenResp> {
  const apiBase = opts.apiBase ?? 'https://api.jamjet.dev'
  const out = opts.stdout ?? ((s) => process.stdout.write(s))

  const dcResp = await request(`${apiBase}/v1/cli/device-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client: opts.client ?? 'jamjet-cli',
      version: opts.version ?? '0.2.0',
    }),
  })
  if (dcResp.statusCode >= 400) {
    const text = await dcResp.body.text()
    throw new Error(`device-code request failed: HTTP ${dcResp.statusCode}: ${text}`)
  }
  const dc = (await dcResp.body.json()) as DeviceCodeResp

  out(`\nOpen this URL: ${dc.verification_uri}\n`)
  out(`Enter code:    ${dc.user_code}\n\n`)
  out(`Waiting for authorization... (Ctrl-C to cancel)\n`)

  const totalTimeout = opts.timeoutMs ?? dc.expires_in * 1000
  const deadline = Date.now() + totalTimeout
  const interval = opts.pollIntervalMs ?? dc.interval * 1000

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))

    const t = await request(`${apiBase}/v1/cli/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: dc.device_code }),
    })

    if (t.statusCode === 200) {
      const data = (await t.body.json()) as TokenResp
      const targetPath = opts.configFile ?? configPath()
      writeConfig(data, apiBase, targetPath)
      out(`\nLinked to project: ${data.project_name} (${data.project_id.slice(0, 8)}…)\n`)
      out(`Config saved to ${targetPath}\n`)
      out(`Run \`jamjet sync start\` to begin pushing events to Cloud.\n`)
      return data
    }
    if (t.statusCode === 401) {
      await t.body.text()
      continue
    }
    if (t.statusCode === 403) {
      throw new Error('authorization denied')
    }
    if (t.statusCode === 400 || t.statusCode === 404) {
      const text = await t.body.text()
      throw new Error(`device_code rejected: HTTP ${t.statusCode}: ${text}`)
    }
    // unexpected status — keep polling but warn
    await t.body.text()
  }

  throw new Error('authorization timed out — run `jamjet cloud link` again')
}

function writeConfig(
  data: { api_key: string; project_id: string },
  apiBase: string,
  path: string,
): void {
  mkdirSync(dirname(path), { recursive: true })

  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      existing = (fromYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {}
    } catch {
      // corrupt — overwrite from scratch
      existing = {}
    }
  }
  const cloud = (existing.cloud as Record<string, unknown> | undefined) ?? {}
  existing.cloud = {
    ...cloud,
    project_id: data.project_id,
    api_key: data.api_key,
    api_base: apiBase,
  }
  writeFileSync(path, toYaml(existing))
  try {
    chmodSync(path, 0o600)
  } catch {
    // best-effort on Windows
  }
}
