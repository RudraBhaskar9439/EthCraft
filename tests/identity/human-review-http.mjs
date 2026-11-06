import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:8789'
const html = await (await fetch(origin)).text()
assert.ok(html.includes('prepare-human-review'))
const token = html.match(/name="agentcity-local-token" content="([a-f0-9]{64})"/)[1]
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-AgentCity-Local': token }
const post = (body, extra = headers) => fetch(origin + '/api/human-review', { method: 'POST', headers: extra, body })
assert.equal((await post('{}', { 'Content-Type': 'application/json' })).status, 403)
assert.equal((await post('{}', { ...headers, Origin: 'https://untrusted.example' })).status, 403)
assert.equal((await post(' '.repeat(1025))).status, 413)
assert.equal((await post('{"builder":"arbitrary"}')).status, 400)
const firstResponse = await post('{}')
assert.equal(firstResponse.status, 200)
const first = await firstResponse.json()
const secondResponse = await post('{}')
assert.equal(secondResponse.status, 200)
const second = await secondResponse.json()
assert.equal(first.agreementHash, second.agreementHash)
const immutableLinks = review => review.links.map(({ role, account, url }) => ({ role, account, url }))
assert.deepEqual(immutableLinks(first), immutableLinks(second))
assert.equal(first.transactionsSubmitted, 0)
assert.equal(first.links.length, 2)
for (const link of first.links) {
  const url = new URL(link.url), fragment = new URLSearchParams(url.hash.slice(1))
  assert.equal(url.origin, origin); assert.equal(url.pathname, '/wallet')
  const response = await fetch(origin + '/api/wallet/handoffs/' + fragment.get('id'), { headers: { 'X-AgentCity-Handoff': fragment.get('token') } })
  assert.equal(response.status, 200)
  const request = await response.json()
  assert.equal(request.expectedAccount, link.account.toLowerCase())
  assert.equal(request.reference.agreementHash, first.agreementHash)
  assert.equal(request.minecraftEconomicBridge, false)
}
const root = new URL('../../', import.meta.url), output = new URL('tests/identity/runs/human-review-' + randomUUID() + '/', root)
const sources = Object.fromEntries(await Promise.all(['backend/src/identity/human-review.mjs', 'backend/src/server.mjs', 'backend/src/web/console.mjs', 'scripts/prepare_human_approval.mjs'].map(async path => [path, createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')])))
await mkdir(output, { recursive: true })
await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', scope: 'Actual local operator preparation and reuse only; no wallet signature or transaction submitted',
  checks: ['missing operator capability and foreign origin refused', 'oversized body and arbitrary participant input refused', 'repeat preparation retains the same immutable agreement and two requests', 'each scoped private link returns the correct wallet and separate-contract boundary'], agreementHash: first.agreementHash, transactionsSubmitted: 0, sources }, null, 2) + '\n')
console.log('PASS operator review preparation, stable reuse and request boundaries; no signatures or transactions submitted')
