import assert from 'node:assert/strict'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
const port = Number(process.env.AGENTCITY_LOCAL_PORT || 8789)
const origin = `http://127.0.0.1:${port}`
const status = await (await fetch(origin + '/api/status')).json()
assert.equal(status.liveGatesPassed, false)
assert.equal(status.result.status, 'pass')
assert.deepEqual(new Set(status.result.phases.map(row => row.phase)), new Set(['P3', 'P4', 'P5', 'P6', 'P7', 'P8']))
const html = await (await fetch(origin)).text()
assert.ok(html.includes('Blockchain balances, purchases and payments do not affect Minecraft.'))
assert.equal(status.result.inference.mode, 'ollama_local')
assert.equal(status.result.inference.live0GVerified, false)
assert.equal(status.publicResult.status, 'pass')
assert.equal(status.publicResult.arkiv.status, 'pass')
assert.ok(status.publicResult.settlement.claimTransactionHash)
assert.equal(status.minecraft.checks.actual_inspection_correct, 16)
assert.equal(status.maintainedMinecraft.status, 'pass')
assert.equal(status.recovery.status, 'pass')
assert.ok(!((await fetch(origin)).headers.get('content-security-policy')).includes('unsafe-inline'))
assert.equal((await fetch(origin + '/console.mjs')).status, 200)
const token = html.match(/name="agentcity-local-token" content="([a-f0-9]{64})"/)[1]
assert.equal((await fetch(origin + '/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
assert.equal((await fetch(origin + '/api/demo', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json', 'X-AgentCity-Local': token }, body: '{}' })).status, 403)
const wrongHost = await new Promise((resolve, reject) => {
  const req = request(origin + '/api/status', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode) })
  req.on('error', reject); req.end()
})
assert.equal(wrongHost, 403)
const directory = new URL(`../../evidence/runs/local-console/${randomUUID()}/`, import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('report.json', directory), JSON.stringify({ status: 'pass', checks: ['current six-phase local result is displayed without live-gate claims', 'separate Minecraft scope and actual local AI are disclosed', 'missing local token refused', 'foreign origin refused', 'foreign host refused'], realMoneySpent: 0 }, null, 2) + '\n')
console.log('PASS console checks: public recovery result, real Minecraft inspection, backup evidence, strict CSP and request boundaries')
