import { describe, it, expect } from 'vitest'
import { Supervisor } from '../src/supervisor.js'

describe('Supervisor', () => {
  it('spawns a subprocess and echoes data through both directions', async () => {
    const sup = new Supervisor({ command: 'cat', args: [] })
    sup.start()

    const received: string[] = []
    sup.onStdout((buf) => received.push(buf.toString()))

    sup.writeStdin(Buffer.from('hello\n'))
    await new Promise((r) => setTimeout(r, 100))
    expect(received.join('')).toContain('hello')

    sup.kill()
  })

  it('propagates exit code through onExit', async () => {
    const sup = new Supervisor({ command: 'sh', args: ['-c', 'exit 7'] })
    sup.start()
    const code = await new Promise<number | null>((resolve) => sup.onExit(resolve))
    expect(code).toBe(7)
  })
})
