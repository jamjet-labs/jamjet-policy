// Cloud Sync config loader.
//
// Resolution order (env wins over file so CI/Docker can override without
// editing a file inside the container):
//   1. read `~/.jamjet/config.yaml` if it exists
//   2. apply env overrides:
//        JAMJET_CLOUD_TOKEN  → cloud.api_key
//        JAMJET_PROJECT      → cloud.project_id
//        JAMJET_API_BASE     → cloud.api_base
//        JAMJET_ARGS_REDACTION → cloud.args_redaction
//   3. validate via ConfigSchema (zod) — defaults applied here
//
// Throws a clear error if neither file nor env supplies api_key + project_id.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigSchema, type Config } from '../types.js'

export function configPath(): string {
  return join(homedir(), '.jamjet', 'config.yaml')
}

export interface LoadConfigOptions {
  path?: string
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const path = opts.path ?? configPath()

  // Start from whatever's in the file (or an empty shell).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any = {}
  if (existsSync(path)) {
    raw = parseYaml(readFileSync(path, 'utf-8')) ?? {}
  }
  raw.cloud = raw.cloud ?? {}

  // Env overrides — written after parsing so they always win.
  const env = process.env
  if (env.JAMJET_CLOUD_TOKEN) raw.cloud.api_key = env.JAMJET_CLOUD_TOKEN
  if (env.JAMJET_PROJECT) raw.cloud.project_id = env.JAMJET_PROJECT
  if (env.JAMJET_API_BASE) raw.cloud.api_base = env.JAMJET_API_BASE
  if (env.JAMJET_ARGS_REDACTION) raw.cloud.args_redaction = env.JAMJET_ARGS_REDACTION

  if (!raw.cloud.api_key || !raw.cloud.project_id) {
    throw new Error(
      `No cloud config found at ${path} and JAMJET_CLOUD_TOKEN/JAMJET_PROJECT not set. ` +
        `Run \`jamjet cloud link\` first.`,
    )
  }

  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid cloud config: ${parsed.error.message}`)
  }
  return parsed.data
}
