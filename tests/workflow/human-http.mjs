import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:8789'
const page = await fetch(origin + '/human')
assert.equal(page.status, 200)
assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
const html = await page.text()
const token = html.match(/name="agentcity-local-token" content="([a-f0-9]{64})"/)[1]
assert.match(html, /id="start"[^>]*disabled/)
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-AgentCity-Local': token }
const post = (action, body, overrides = headers) => fetch(origin + '/api/human/' + action, { method: 'POST', headers: overrides, body })
assert.equal((await post('prepare', '{}', { 'Content-Type': 'application/json' })).status, 403)
assert.equal((await post('prepare', '{}', { ...headers, Origin: 'https://untrusted.example' })).status, 403)
assert.equal((await post('prepare', ' '.repeat(1025))).status, 413)
assert.equal((await post('prepare', '{')).status, 400)
for (const [action, input] of [['prepare', { action: 'fund', sender: 'arbitrary' }], ['identity', { role: 'operator' }], ['begin', { operationId: 'arbitrary' }]]) {
  const response = await post(action, JSON.stringify(input))
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /^HUMAN_SESSION_/)
}
assert.equal((await post('status', '{}')).status, 404)
assert.equal((await post('arbitrary', '{}')).status, 404)
for (const asset of ['human.mjs', 'human.css']) assert.equal((await fetch(origin + '/' + asset)).status, 200)
const response = await fetch(origin + '/api/human/status')
assert.equal(response.status, 200)
const status = await response.json()
assert.equal(typeof status.identities.ready, 'boolean')
assert.equal(status.identities.roles.length, 2)
const forbidden = new Set(['request', 'url', 'urlFragment', 'privateDirectory', 'reviewDirectory', 'token', 'capability'])
function redacted(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) { assert.equal(forbidden.has(key), false, 'Status exposed ' + key); redacted(item) }
}
redacted(status)
const root = new URL('../../', import.meta.url)
const output = new URL('evidence/runs/human-http/' + randomUUID() + '/', root)
const sources = Object.fromEntries(await Promise.all(['backend/src/server.mjs', 'backend/src/web/human.mjs', 'backend/src/workflow/human-session.mjs'].map(async file => [file, createHash('sha256').update(await readFile(new URL(file, root))).digest('hex')])))
await mkdir(output, { recursive: true })
await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', scope: 'Actual local HTTP boundaries and read-only human-session preflight; no signature or transaction', checks: ['local operator capability and same origin enforced', 'strict fields, body size and malformed JSON refused', 'assets and disabled initial agreement control served', 'real session status omits private links and unsigned transaction requests'], identitiesReady: status.identities.ready, linkedRoles: status.identities.roles.filter(person => person.linked).length, sources, transactionsSubmitted: 0 }, null, 2) + '\n')
console.log('PASS four human HTTP boundary and read-only preflight groups; no signatures or transactions')
