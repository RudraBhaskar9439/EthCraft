import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:8789'
const page = await fetch(origin + '/wallet')
assert.equal(page.status, 200)
assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
assert.ok(!page.headers.get('content-security-policy').includes('unsafe-inline'))
for (const extension of ['mjs', 'css']) assert.equal((await fetch(origin + '/wallet.' + extension)).status, 200)
const path = origin + '/api/wallet/handoffs/' + randomUUID()
assert.equal((await fetch(path)).status, 400)
assert.equal((await fetch(path + '/signature', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
assert.equal((await fetch(path + '/signature', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413)
const output = new URL(`runs/http-${randomUUID()}/`, import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', checks: ['fixed wallet assets and strict browser headers', 'unprepared or missing-capability request refused', 'foreign submission origin refused', 'oversized signing submission refused'], realHumanApprovals: 0, blockchainTransactions: 0 }, null, 2) + '\n')
console.log('PASS wallet HTTP boundaries; no human request, signature or transaction created')
