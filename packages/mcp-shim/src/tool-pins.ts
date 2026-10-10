/**
 * Tool-definition pinning (rug-pull defence).
 *
 * A tool's definition is what the model reads and what the user approved:
 * name, title, description, input and output schema, and annotations. The shim
 * hashes a canonical form of those fields and compares it with a pin, either
 * recorded on first sight (tofu) or supplied by an operator-maintained allowlist.
 * A definition that no longer matches its pin is withheld from the client and
 * every call to it is refused until someone re-approves the new hash.
 *
 * `icons` and `_meta` are not pinned: icons are display-only and `_meta` is an
 * open extension map that servers may fill with volatile data.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sha256Canonical } from '@jamjet/mcp-threat'

export type PinMode = 'tofu' | 'allowlist' | 'off'

export interface PinEntry {
  hash: string
  pinned_at?: string
  source?: 'first_sight' | 'approved' | 'allowlist'
}

export interface PinFile {
  version: 1
  servers: Record<string, Record<string, PinEntry>>
}

export type PinVerdict =
  | { status: 'match' }
  | { status: 'first_sight' }
  | { status: 'changed'; pinned_hash: string; observed_hash: string }
  | { status: 'not_pinned'; observed_hash: string }

const PINNED_FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'] as const
const HASH_RE = /^sha256:[0-9a-f]{64}$/

export function canonicalToolDefinition(tool: unknown): Record<string, unknown> {
  const src = (tool && typeof tool === 'object' ? tool : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of PINNED_FIELDS) {
    if (Object.hasOwn(src, f) && src[f] !== undefined) out[f] = src[f]
  }
  return out
}

export function toolDefinitionHash(tool: unknown): string {
  return sha256Canonical(canonicalToolDefinition(tool))
}

// ---------------------------------------------------------------------------
// Invisible / control characters
// ---------------------------------------------------------------------------

export interface InvisibleFinding {
  path: string
  codepoint: string
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u
const FORMAT = /\p{Cf}/u
const CONTROL = /\p{Cc}/u

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
}

/** Characters that render as nothing (or reorder text) but are read by the model. */
function isHiddenCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false
  const ch = String.fromCodePoint(cp)
  if (CONTROL.test(ch) || FORMAT.test(ch)) return true // includes ZW*, bidi, TAG block, BOM, soft hyphen
  if (isVariationSelector(cp)) return true
  return (
    cp === 0x034f || // combining grapheme joiner
    cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 || // hangul fillers
    cp === 0x17b4 || cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) || // mongolian selectors / vowel separator
    (cp >= 0x1d173 && cp <= 0x1d17a) // musical formatting
  )
}

function isPictograph(cp: number | undefined): boolean {
  return cp !== undefined && PICTOGRAPH.test(String.fromCodePoint(cp))
}

/**
 * Find hidden characters in one string. Emoji are the one legitimate use of
 * otherwise-invisible code points, so exactly two shapes are allowed:
 * a single U+FE0E/U+FE0F directly after a pictograph, and a ZWJ between two
 * pictographs (optionally after that one selector). Anything else, including a
 * run of selectors behind an emoji, is reported.
 */
function scanString(s: string): number[] {
  const cps = Array.from(s, (c) => c.codePointAt(0)!)
  const hits: number[] = []
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!
    if (!isHiddenCodePoint(cp)) continue
    if ((cp === 0xfe0e || cp === 0xfe0f) && isPictograph(cps[i - 1])) continue
    if (cp === 0x200d) {
      const prev = cps[i - 1] === 0xfe0f && isPictograph(cps[i - 2]) ? cps[i - 2] : cps[i - 1]
      if (isPictograph(prev) && isPictograph(cps[i + 1])) continue
    }
    hits.push(cp)
  }
  return hits
}

function u(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
}

/** Escape hidden and control code points so untrusted text cannot hide or rewrite terminal output. */
export function printable(text: string): string {
  return Array.from(text, (c) => {
    const cp = c.codePointAt(0)!
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || isHiddenCodePoint(cp)) {
      return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
    }
    return c
  }).join('')
}

function displayKey(key: string): string {
  return printable(key)
}

/** Walk every key and string value of the pinned definition fields. */
export function findInvisibleCharacters(tool: unknown): InvisibleFinding[] {
  const out: InvisibleFinding[] = []
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 64) return
    if (typeof value === 'string') {
      for (const cp of scanString(value)) out.push({ path, codepoint: u(cp) })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1))
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${displayKey(k)}` : displayKey(k)
        for (const cp of scanString(k)) out.push({ path: childPath, codepoint: u(cp) })
        walk(v, childPath, depth + 1)
      }
    }
  }
  walk(canonicalToolDefinition(tool), '', 0)
  return out
}

// ---------------------------------------------------------------------------
// Pin file
// ---------------------------------------------------------------------------

export function emptyPinFile(): PinFile {
  return { version: 1, servers: {} }
}

function validatePinFile(parsed: unknown, path: string): PinFile {
  const p = parsed as { version?: unknown; servers?: unknown } | null
  if (!p || typeof p !== 'object') throw new Error(`pin file ${path}: not a JSON object`)
  if (p.version !== 1) throw new Error(`pin file ${path}: unsupported version ${String(p.version)}`)
  if (!p.servers || typeof p.servers !== 'object' || Array.isArray(p.servers)) {
    throw new Error(`pin file ${path}: servers must be an object`)
  }
  for (const [server, tools] of Object.entries(p.servers as Record<string, unknown>)) {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
      throw new Error(`pin file ${path}: servers.${server} must be an object`)
    }
    for (const [tool, entry] of Object.entries(tools as Record<string, unknown>)) {
      const hash = (entry as { hash?: unknown } | null)?.hash
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
        throw new Error(`pin file ${path}: servers.${server}.${tool}.hash must be sha256:<64 hex>`)
      }
    }
  }
  return p as PinFile
}

/** Missing file: empty pin set. Unreadable or malformed file: throws (fail closed). */
export function loadPinFile(path: string): PinFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyPinFile()
    throw err
  }
  return validatePinFile(JSON.parse(raw), path)
}

/** Re-read, merge one entry, and replace the file atomically. */
export function savePin(path: string, server: string, tool: string, entry: PinEntry): void {
  if (!HASH_RE.test(entry.hash)) throw new Error(`refusing to pin malformed hash '${entry.hash}'`)
  const current = loadPinFile(path)
  const tools = Object.hasOwn(current.servers, server) ? { ...current.servers[server] } : {}
  tools[tool] = entry
  const next: PinFile = { version: 1, servers: { ...current.servers, [server]: tools } }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

export function checkPin(pins: PinFile, server: string, tool: string, observedHash: string, mode: Exclude<PinMode, 'off'>): PinVerdict {
  const tools = Object.hasOwn(pins.servers, server) ? pins.servers[server] : undefined
  const entry = tools && Object.hasOwn(tools, tool) ? tools[tool] : undefined
  if (!entry) {
    return mode === 'tofu' ? { status: 'first_sight' } : { status: 'not_pinned', observed_hash: observedHash }
  }
  if (entry.hash === observedHash) return { status: 'match' }
  return { status: 'changed', pinned_hash: entry.hash, observed_hash: observedHash }
}
