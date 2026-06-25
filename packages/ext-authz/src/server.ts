import { createServer as createHttpServer, type Server } from 'node:http'
import { handleAuthzWithHold, type AuthzDepsV2 } from './handle.js'

// Cap the buffered ext_authz body so a large or slow request cannot exhaust memory.
const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

export function createServer(deps: AuthzDepsV2): Server {
  return createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false // a response has been sent (size cap, stream error, or normal end)

    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        done = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload_too_large' }))
        return
      }
      chunks.push(c)
    })

    // Without this listener a stream-level error (e.g. client disconnect) would
    // surface as an unhandled 'error' event and crash the process.
    req.on('error', () => {
      if (done) return
      done = true
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad_request' }))
      }
    })

    req.on('end', () => {
      if (done) return
      done = true
      try {
        const rawBody = Buffer.concat(chunks).toString('utf-8')
        const headers: Record<string, string | undefined> = {}
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v
        const result = handleAuthzWithHold(rawBody, headers, deps)
        res.writeHead(result.status, result.headers)
        res.end(result.body)
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal_error' }))
        }
      }
    })
  })
}
