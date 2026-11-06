import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyMinecraftSession, readMinecraftAuthority } from '../../../backend/src/identity/minecraft-sessions.mjs'

const execute = promisify(execFile)
const root = new URL('../../../', import.meta.url)
const require = createRequire(new URL('../../../tests/compatibility/package.json', import.meta.url))
const mineflayer = require('mineflayer')
const runId = randomUUID(), now = Date.now(), player = randomUUID(), session = randomUUID(), boot = randomUUID()
const metadata = { serverId: 'agentcity-online-auth-' + 'a'.repeat(32), serverBootId: boot }
const wallet = '0x1111111111111111111111111111111111111111'
const binding = { serverId: metadata.serverId, serverBootId: boot, playerUuid: player, sessionId: session }
const entry = { ...binding, name: 'FixtureOnly', connected: true, joinedAtMs: now - 1000, pairedAtMs: now - 500, expiresAtMs: now + 30000, wallet }
const snapshot = { serverId: metadata.serverId, serverBootId: boot, onlineMode: true, directAuthentication: true, economicBridge: false, ready: true, atMs: now, sessions: [entry] }
const checks = [], report = { status: 'fail', checks, scope: 'Focused pure session-authority fixtures plus actual empty online-mode software and an unauthenticated offline client refusal; no genuine human session or wallet signature claimed.',
  realHumanSessionsVerified: false, humanWalletLinksVerified: false, launcherStarted: false, blockchainTransactions: 0, realMoneySpent: 0 }
let client
const files = ['config/minecraft-runtime.json', '.local/inspection/AgentCity.jar', '.local/access-check/active.json', '.local/maintained-world/active.json']
const digest = async file => createHash('sha256').update(await readFile(new URL(file, root))).digest('hex')
const frozen = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, await digest(file)])))
try {
  assert.equal(verifyMinecraftSession({ metadata, snapshot, binding, wallet, now }).sessionId, session)
  for (const change of [{ onlineMode: false }, { directAuthentication: false }]) assert.throws(() => verifyMinecraftSession({ metadata, snapshot: { ...snapshot, ...change }, binding, wallet, now }), /AUTHENTICATED_MINECRAFT_SESSION_REQUIRED/)
  checks.push('offline/proxy authority is refused; a valid fixture binding uses a public login UUID rather than a bearer credential')
  for (const changed of [{ connected: false }, { expiresAtMs: now }, { sessionId: randomUUID() }, { serverBootId: randomUUID() }]) {
    assert.throws(() => verifyMinecraftSession({ metadata, snapshot: { ...snapshot, sessions: [{ ...entry, ...changed }] }, binding, wallet, now }), /AUTHENTICATED_MINECRAFT_SESSION_REQUIRED/)
  }
  assert.throws(() => verifyMinecraftSession({ metadata, snapshot, binding: { ...binding, serverId: 'other-server' }, wallet, now }), /AUTHENTICATED_MINECRAFT_SESSION_REQUIRED/)
  assert.throws(() => verifyMinecraftSession({ metadata, snapshot, binding, wallet: '0x2222222222222222222222222222222222222222', now }), /AUTHENTICATED_MINECRAFT_SESSION_REQUIRED/)
  checks.push('logout, expiry, changed login/boot/server and changed requested wallet invalidate a session')
  const before = await frozen()
  const started = await execute('python3', ['scripts/online_auth_probe.py', 'start'], { cwd: new URL(root).pathname, timeout: 180000, maxBuffer: 32768 })
  const health = JSON.parse(started.stdout)
  assert.equal(health.ready, true); assert.equal(health.onlineMode, true)
  const authority = await readMinecraftAuthority()
  assert.equal(authority.snapshot.sessions.length, 0)
  assert.deepEqual(await frozen(), before)
  assert.equal((await fetch('http://127.0.0.1:25599/status')).status, 401)
  report.software = health
  report.protectedArtifactHashesUnchanged = before
  checks.push('owned pinned direct online-mode probe is healthy with zero human sessions; API requires its private token and existing game artifacts stay unchanged')

  let spawned = false
  await new Promise((resolve, reject) => {
    client = mineflayer.createBot({ host: '127.0.0.1', port: 25598, username: 'AuthProbeOffline', version: '1.21.11', auth: 'offline' })
    const timeout = setTimeout(() => { client.quit(); reject(new Error('Offline client was not conclusively refused within the bounded probe')) }, 20000)
    const done = () => { clearTimeout(timeout); resolve() }
    client.once('spawn', () => { spawned = true; clearTimeout(timeout); reject(new Error('An offline fixture client was unexpectedly admitted')) })
    client.once('error', done); client.once('kicked', done); client.once('end', done)
  })
  assert.equal(spawned, false)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal((await readMinecraftAuthority()).snapshot.sessions.length, 0)
  checks.push('an actual unauthenticated offline client cannot join and creates no authenticated player session')
  report.status = 'pass'
} catch (error) { report.error = { type: error.name, message: error.message.slice(0, 300) }; process.exitCode = 1 }
finally {
  client?.quit()
  report.finishedAt = new Date().toISOString()
  const sources = ['tests/identity/online-auth-probe/AgentCityOnlineAuth.java', 'tests/identity/online-auth-probe/plugin.yml', 'tests/identity/online-auth-probe/build.py', 'tests/identity/online-auth-probe/checks.mjs', 'scripts/online_auth_probe.py', 'backend/src/identity/minecraft-sessions.mjs', 'backend/src/identity/http-runtime.mjs', 'scripts/prepare_human_identity.mjs']
  report.sources = Object.fromEntries(await Promise.all(sources.map(async file => [file, await digest(file)])))
  const output = new URL(`tests/identity/runs/online-auth-${runId}/`, root)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence: new URL('report.json', output).pathname }))
}
