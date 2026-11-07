#!/usr/bin/env node
// Claude Code treats exit 2 from a PreToolUse hook as "block" and any other
// non-zero exit as a non-blocking error that lets the tool run. Every way out
// of this process other than an explicit allow or ask must therefore exit 2,
// including a crash and a failed import. Only node: built-ins are imported
// statically; the rest loads inside the try below.
import { writeSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HookOutcome } from './run.js'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf-8')
  let offset = 0
  while (offset < buf.length) offset += writeSync(fd, buf, offset)
}

let finished = false

function finish(outcome: HookOutcome): void {
  if (finished) return
  finished = true
  let code: number = outcome.exitCode
  let stderr = outcome.stderr
  if (outcome.stdout) {
    try {
      writeAll(1, outcome.stdout)
    } catch (err) {
      // An ask decision that never reaches Claude Code reads as exit 0 with no
      // output, which is an allow. Block instead.
      code = 2
      stderr += `jamjet-hook: blocking tool call: could not write the decision to stdout: ${message(err)}\n`
    }
  }
  if (stderr) {
    try {
      writeAll(2, stderr)
    } catch {
      // Nothing else to report to; the exit code still carries the decision.
    }
  }
  process.exit(code)
}

function failClosed(err: unknown): void {
  finish({ exitCode: 2, stdout: '', stderr: `jamjet-hook: blocking tool call: ${message(err)}\n` })
}

process.on('uncaughtException', failClosed)
process.on('unhandledRejection', failClosed)

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

async function main(): Promise<void> {
  const { runHook } = await import('./run.js')
  const stdin = await readStdin()
  finish(runHook({ argv: process.argv.slice(2), env: process.env, stdin, home: homedir() }))
}

main().catch(failClosed)
