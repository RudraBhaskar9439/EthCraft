// Controlled vanilla-client fixture on the isolated city copy; no live owner approval or inference.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(import.meta.url)
const mineflayer = require('../compatibility/node_modules/mineflayer')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const isolated = await json(join(root, '.local/mumbai-city/isolated-active.json'))
assert.equal(isolated.owner, 'agentcity-mumbai-city-isolated')
assert.equal(isolated.cleaned, undefined)
assert.equal(isolated.controlPort, 25997)
assert.equal(isolated.gamePort, 25996)
const token = (await readFile(join(isolated.runtime, 'api-token'), 'utf8')).trim()
const runId = randomUUID(), directory = join(root, 'evidence/runs/voice-native', runId)
const report = { status: 'fail', isolatedId: isolated.id, pluginSha256: isolated.pluginSha256,
  serverId: isolated.serverId, worldIds: isolated.sourceWorldIds, checks: [],
  scope: 'Isolated Paper and Simple Voice Chat with controlled vanilla Mineflayer client; no real microphone or provider requests',
  independentHumansVerified: 0, inferenceRequests: 0, liveWorldMutations: 0 }
let bot
async function api(path, body) {
  const response = await fetch('http://127.0.0.1:25997/playable/' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
  const value = await response.json(); assert(response.ok, 'Native API failed: ' + response.status + ' ' + (value.reason || value.code || '')); return value
}
async function wait(read, accepts, label) {
  const end = Date.now() + 40000
  while (Date.now() < end) { const value = await read(); if (accepts(value)) return value; await delay(150) }
  throw Error('Timeout: ' + label)
}
const pass = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
try {
  const unauthorized = await fetch('http://127.0.0.1:25997/playable/voice/status')
  assert.equal(unauthorized.status, 401); pass('Native voice routes require the private bearer')
  const status = await wait(() => api('voice/status'), s => s.available && s.initialized, 'Voice Chat initialization')
  assert.equal(status.enrolled.length, 0); assert.equal(status.pending.length, 0)
  pass('Real Simple Voice Chat server API initialized without any audio inference')
  const principalId = randomUUID(), name = 'Vox' + runId.slice(0, 8), messages = []
  await api('discord/reserve', { playerName: name, principalId, discordId: String(660000000000000000n + BigInt('0x' + runId.slice(0, 8))), accountKind: 'local', expiresAtMs: Date.now() + 180000 })
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25996, username: name, auth: 'offline', version: '1.21.11' })
  bot.on('physicsTick', () => { if (bot._client.state === 'play') bot._client.write('tick_end', {}) })
  bot.on('error', () => {}); bot.on('messagestr', text => messages.push(text))
  await Promise.race([once(bot, 'spawn'), new Promise((_, reject) => setTimeout(() => reject(Error('Fixture spawn timeout')), 40000).unref())])
  const playerId = bot._client.uuid
  const session = await wait(() => api('session?playerId=' + playerId), s => s.online && s.connectionId, 'native session')
  assert.equal(session.pendingAuthentication, true)
  bot.chat('/voice 0g')
  await wait(() => messages, lines => lines.some(l => l.includes('Approve this Minecraft connection')), 'unapproved voice denial')
  assert.equal((await api('voice/status')).enrolled.length, 0)
  pass('Unapproved player cannot enroll for AI voice')
  await api('discord/approve', { playerId, connectionId: session.connectionId, principalId })
  await wait(() => api('session?playerId=' + playerId), s => s.pendingAuthentication === false, 'controlled approval')
  await delay(800); bot.chat('/voice agent')
  await wait(() => messages, lines => lines.some(l => l.includes('Install the EthCraft Fabric')), 'vanilla client installation hint')
  const after = await api('voice/status'); assert.equal(after.enrolled.length, 0); assert.equal(after.pending.length, 0)
  pass('Approved vanilla client gets an installation hint without enrollment or fabricated audio')
  const native = await api('status'); assert.equal(native.mumbai.worldUuid, isolated.worldUuid)
  pass('Existing Mumbai world binding preserved')
  report.status = 'pass'
} catch (error) { report.error = error.message; throw error }
finally {
  bot?.quit(); await mkdir(directory, { recursive: true })
  const reportPath = join(directory, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (report.status === 'pass') {
    const proof = { owner: 'agentcity-mumbai-city-isolated-proof', status: 'pass', isolatedId: isolated.id,
      ...Object.fromEntries(['pluginSha256','serverId','worldUuid','sourceActiveSha256','sourceMumbaiConfigSha256','sourceWorldIds'].map(k => [k, isolated[k]])),
      report: reportPath.slice(root.length), reportSha256: sha(await readFile(reportPath)) }
    await writeFile(join(root, '.local/mumbai-city/isolated-verification.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 })
  }
  console.log('Report: ' + reportPath)
}
