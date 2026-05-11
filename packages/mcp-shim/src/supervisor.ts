import { spawn, type ChildProcess } from 'node:child_process'

export interface SupervisorOptions {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export class Supervisor {
  private child: ChildProcess | null = null
  private stdoutHandlers: Array<(buf: Buffer) => void> = []
  private stderrHandlers: Array<(buf: Buffer) => void> = []
  private exitHandlers: Array<(code: number | null) => void> = []

  constructor(private options: SupervisorOptions) {}

  start(): void {
    this.child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
    })
    this.child.stdout?.on('data', (b: Buffer) => this.stdoutHandlers.forEach((h) => h(b)))
    this.child.stderr?.on('data', (b: Buffer) => this.stderrHandlers.forEach((h) => h(b)))
    this.child.on('exit', (code) => this.exitHandlers.forEach((h) => h(code)))
  }

  writeStdin(buf: Buffer): void {
    if (!this.child?.stdin?.writable) {
      throw new Error('supervisor: subprocess stdin not writable')
    }
    this.child.stdin.write(buf)
  }

  onStdout(handler: (buf: Buffer) => void): void {
    this.stdoutHandlers.push(handler)
  }

  onStderr(handler: (buf: Buffer) => void): void {
    this.stderrHandlers.push(handler)
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal)
  }
}
