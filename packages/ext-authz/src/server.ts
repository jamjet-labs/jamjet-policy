import { createServer as createHttpServer, type Server } from 'node:http'
import { handleAuthzWithHold, type AuthzDepsV2 } from './handle.js'

export function createServer(deps: AuthzDepsV2): Server {
  return createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8')
      const headers: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v
      const result = handleAuthzWithHold(rawBody, headers, deps)
      res.writeHead(result.status, result.headers)
      res.end(result.body)
    })
  })
}
