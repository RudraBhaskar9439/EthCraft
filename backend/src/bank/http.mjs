import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

/** Loopback operator routes. The runtime still verifies each financial owner and term. */
export function createBankHttpHandler({ rootDirectory, port, capability, getRuntime, staticFiles }) {
  const origin = `http://127.0.0.1:${port}`
  const assets = staticFiles || { '/': ['bank.html', 'text/html; charset=utf-8'], '/bank.mjs': ['bank.mjs', 'text/javascript; charset=utf-8'], '/bank.css': ['bank.css', 'text/css; charset=utf-8'] }
  const send = (response, status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  return async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    if (request.headers.host !== `127.0.0.1:${port}`) return send(response, 403, { error: 'BANK_LOCAL_HOST_REQUIRED' })
    let pathname
    try { pathname = new URL(request.url, origin).pathname } catch { return send(response, 400, { error: 'BANK_LOCAL_PATH_REQUIRED' }) }
    try {
      if (request.method === 'GET' && assets[pathname]) {
        const [file, type] = assets[pathname], body = await readFile(join(rootDirectory, 'backend/src/web', file), 'utf8')
        response.writeHead(200, { 'Content-Type': type }).end(file.endsWith('.html') ? body.replace('{{BANK_CAPABILITY}}', capability) : body)
        return
      }
      const supplied = Buffer.from(String(request.headers['x-agentcity-bank'] || ''))
      if (supplied.length !== capability.length || !timingSafeEqual(supplied, Buffer.from(capability))) return send(response, 403, { error: 'BANK_LOCAL_CAPABILITY_REQUIRED' })
      if (request.method === 'GET' && pathname === '/api/state') return send(response, 200,
        await (await getRuntime()).state(new URL(request.url, origin).searchParams.get('principalId') || undefined))
      if (request.method !== 'POST' || !['/api/preview', '/api/confirm', '/api/operation', '/api/health', '/api/observation'].includes(pathname)) return send(response, 404, { error: 'BANK_ACTION_NOT_FOUND' })
      if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(response, 403, { error: 'BANK_SAME_ORIGIN_JSON_REQUIRED' })
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > 16384) return send(response, 413, { error: 'BANK_REQUEST_TOO_LARGE' })
        chunks.push(chunk)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(response, 400, { error: 'BANK_JSON_REQUIRED' }) }
      if (!input || Array.isArray(input) || typeof input !== 'object') return send(response, 400, { error: 'BANK_FIELDS_REQUIRED' })
      const runtime = await getRuntime()
      if (pathname === '/api/health') return send(response, 200, await runtime.publishHealth())
      if (pathname === '/api/observation') return typeof runtime.publishReference === 'function'
        ? send(response, 200, await runtime.publishReference()) : send(response, 404, { error: 'BANK_ACTION_NOT_FOUND' })
      return send(response, 200, await runtime[pathname.slice('/api/'.length)](input))
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message
        : error.code === 'ENOENT' ? 'BANK_DEPLOYMENT_NOT_READY' : 'BANK_OPERATION_WAITING_FOR_RECONCILIATION'
      console.warn('Bank operation:', code)
      send(response, 409, { error: code, message: code.replaceAll('_', ' ').toLowerCase() + '. Review the retained operation before retrying.' })
    }
  }
}
