// In-memory HTTP request/response tests only. No listener, browser, RPC or signer.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBankHttpHandler } from '../../backend/src/bank/http.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url)), port = 8794, capability = 'a'.repeat(64)
const report = { status: 'fail', scope: 'In-memory HTTP requests and mocked runtime; no browser, network, signing or native effect.', checks: [], publicTransactions: 0, signatures: 0, networkCalls: 0 }
let openings = 0
const calls = [], runtime = {
  async state(principalId) { calls.push(['state', principalId]); return { principalId } },
  async preview(input) { calls.push(['preview', input]); return { status: 'preview', ...input } },
  async confirm(input) { calls.push(['confirm', input]); return { status: 'complete', operationId: input.operationId } },
  async operation(input) { calls.push(['operation', input]); return input },
  async publishHealth() { calls.push(['health']); return { available: true } }
}
const handler = createBankHttpHandler({ rootDirectory: root, port, capability, getRuntime: async () => { openings++; return runtime } })
async function request({ method = 'POST', url = '/api/preview', headers = {}, body = {}, raw, chunks } = {}) {
  const stream = Readable.from(chunks || [Buffer.from(raw === undefined ? JSON.stringify(body) : raw)])
  Object.assign(stream, { method, url, headers: { host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port,
    'content-type': 'application/json', 'x-agentcity-bank': capability, ...headers } })
  const response = { headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); return this },
    end(body) { this.body = body; return this }
  }
  await handler(stream, response)
  return response
}
const pass = name => report.checks.push({ name, status: 'pass' })
try {
  let response = await request({ method: 'GET', url: '/api/state', headers: { 'x-agentcity-bank': '' } })
  assert.equal(response.status, 403); assert.equal(openings, 0)
  response = await request({ headers: { host: 'attacker.invalid' } }); assert.equal(response.status, 403)
  response = await request({ headers: { origin: 'https://attacker.invalid' } }); assert.equal(response.status, 403)
  response = await request({ headers: { 'content-type': 'text/plain' } }); assert.equal(response.status, 403)
  assert.equal(openings, 0); assert.equal(calls.length, 0)
  pass('host capability origin and JSON content type are required before runtime access')
  response = await request({ raw: 'x'.repeat(16385) }); assert.equal(response.status, 413)
  response = await request({ chunks: [Buffer.alloc(9000, 65), Buffer.alloc(9000, 65)] }); assert.equal(response.status, 413)
  response = await request({ raw: '{bad' }); assert.equal(response.status, 400)
  response = await request({ body: [] }); assert.equal(response.status, 400)
  response = await request({ body: null }); assert.equal(response.status, 400)
  assert.equal(openings, 0)
  pass('oversized malformed and non-object bodies cannot dispatch an operation')
  for (const url of ['/api/shell', '/api/constructor', '/api/withdraw', '/api/__proto__', '/api/confirm/extra']) {
    response = await request({ url, body: { command: 'untrusted' } }); assert.equal(response.status, 404)
  }
  response = await request({ method: 'GET', url: '/api/confirm' }); assert.equal(response.status, 404)
  assert.equal(openings, 0)
  pass('only explicit HTTP routes dispatch and there is no arbitrary command endpoint')
  const preview = { principalId: 'operator-fixture', action: 'repay', loanId: 'example' }
  response = await request({ body: preview }); assert.equal(response.status, 200)
  assert.deepEqual(calls, [['preview', preview]])
  pass('preview dispatch does not confirm sign or change its request fields')
  const confirm = { principalId: 'operator-fixture', operationId: 'retained-operation', termsDigest: 'exact-saved-digest' }
  response = await request({ url: '/api/confirm', body: confirm }); assert.equal(response.status, 200)
  assert.deepEqual(calls[1], ['confirm', confirm])
  response = await request({ url: '/api/operation', body: confirm }); assert.deepEqual(calls[2], ['operation', confirm])
  response = await request({ method: 'GET', url: '/api/state?principalId=operator-fixture' }); assert.deepEqual(calls[3], ['state', 'operator-fixture'])
  response = await request({ url: '/api/health' }); assert.deepEqual(calls[4], ['health'])
  pass('explicit confirmation status and health routes call only their named runtime method')
  response = await request({ method: 'GET', url: '/' }); assert.equal(response.status, 200)
  assert.ok(response.body.includes(capability)); assert.equal(openings, 5)
  assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
  assert.ok(response.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"))
  const failing = createBankHttpHandler({ rootDirectory: root, port, capability, getRuntime: async () => { throw Error('sensitive provider payload') } })
  const stream = Readable.from([Buffer.from('{}')]); Object.assign(stream, { method: 'POST', url: '/api/preview', headers: {
    host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json', 'x-agentcity-bank': capability } })
  const safe = { headers: {}, setHeader() {}, writeHead(status) { this.status = status; return this }, end(body) { this.body = body } }
  await failing(stream, safe); assert.equal(safe.status, 409); assert.ok(!safe.body.includes('sensitive provider payload'))
  pass('static delivery preserves browser protections and errors redact provider payloads')
  const beforeObservation = { openings, calls: calls.length }
  response = await request({ url: '/api/observation', headers: { 'x-agentcity-bank': '' } }); assert.equal(response.status, 403)
  response = await request({ url: '/api/observation', headers: { origin: 'https://attacker.invalid' } }); assert.equal(response.status, 403)
  response = await request({ url: '/api/observation', raw: 'x'.repeat(16385) }); assert.equal(response.status, 413)
  response = await request({ method: 'GET', url: '/api/observation' }); assert.equal(response.status, 404)
  assert.equal(openings, beforeObservation.openings); assert.equal(calls.length, beforeObservation.calls)
  response = await request({ url: '/api/observation' }); assert.equal(response.status, 404)
  assert.equal(calls.length, beforeObservation.calls, 'An unconfigured bank host cannot publish a reference or dispatch another method')
  runtime.publishReference = async (...args) => { assert.deepEqual(args, []); calls.push(['observation']); return { pending: false } }
  response = await request({ url: '/api/observation', body: { method: 'publishHealth', principalId: 'untrusted', operationId: 'replacement' } })
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { pending: false })
  assert.deepEqual(calls.slice(beforeObservation.calls), [['observation']])
  pass('observation publication requires capability and same origin, enforces body bounds and calls only the configured publisher')
  report.status = 'pass'
  report.sourceHashes = Object.fromEntries(await Promise.all(['backend/src/bank/http.mjs', 'tests/bank/http.mjs'].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  const output = join(root, 'evidence/runs/bank-http', randomUUID()); await mkdir(output, { recursive: true })
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(output, 'report.json'), error: report.error }))
}
