// Actual controlled client proof. This never submits transactions or grants items.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(new URL('../..', import.meta.url).pathname)
const activeCheck = process.argv.length === 3 && process.argv[2] === '--active'
assert(process.argv.length === 2 || activeCheck, 'Use no arguments for the isolated host, or --active for a dedicated visitor on the installed laptop host')
const require = createRequire(new URL('../compatibility/package.json', import.meta.url))
const mineflayer = require('mineflayer')
const meta = JSON.parse(await readFile(join(root, '.local/mumbai', activeCheck ? 'active.json' : 'isolated-active.json'), 'utf8'))
assert.equal(meta.owner, activeCheck ? 'agentcity-mumbai-active' : 'agentcity-mumbai-isolated')
assert.equal(meta.gamePort, activeCheck ? 25596 : 25996)
assert.equal(meta.controlPort, activeCheck ? 25597 : 25997)
const token = (await readFile(join(meta.runtime, 'api-token'), 'utf8')).trim()
const imported = JSON.parse(await readFile(join(root, '.local/mumbai/mumbai-world.json'), 'utf8'))
assert.equal(meta.worldUuid, imported.worldUuid)
const runId = randomUUID(), directory = join(root, 'evidence/runs/mumbai-visit', runId)
await mkdir(directory, { recursive: true })
const report = { runId, status: 'fail', scope: activeCheck ? 'Actual dedicated controlled Mumbai visitor on the owned laptop host; no human or financial qualification.' : 'Actual isolated Paper load and copied controlled bidder; no active host, human or financial qualification.',
  publicTransactions: 0, walletSignatures: 0, paidModelCalls: 0, checks: [], messages: [] }
let bot, disconnected = false
const stable = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const hash = value => createHash('sha256').update(value).digest('hex')
async function native(path, body) {
  const response = await fetch(`http://127.0.0.1:${meta.controlPort}/playable/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const value = await response.json()
  if (!response.ok) throw Error(value.reason || value.code || value.error || 'MUMBAI_NATIVE_REFUSAL')
  return value
}
async function poll(read, accept, label, timeout = 45000) {
  const until = Date.now() + timeout
  do {
    if (disconnected) throw Error('MUMBAI_CLIENT_DISCONNECTED_' + label)
    const value = await read()
    if (accept(value)) return value
    await delay(200)
  } while (Date.now() < until)
  throw Error('MUMBAI_TIMEOUT_' + label)
}
async function worldIds() {
  const { stdout } = await promisify(execFile)('python3', ['-c',
    'import json,sys; from pathlib import Path; from scripts.mumbai_host import world_ids; print(json.dumps(world_ids(Path(sys.argv[1]))))', meta.runtime],
  { cwd: root, timeout: 20000, maxBuffer: 65536 })
  return JSON.parse(stdout)
}
const inventory = () => bot.inventory.items().map(item => ({ slot: item.slot, name: item.name, count: item.count,
  nbt: item.nbt || null, components: item.components || null })).sort((a, b) => a.slot - b.slot)
const check = (name, details = {}) => report.checks.push({ name, status: 'pass', ...details })

try {
  const status = await native('status')
  assert.equal(status.available, true)
  assert.equal(status.mumbai?.ready, true)
  assert.equal(status.mumbai.world, 'agentcity_mumbai')
  assert.equal(status.mumbai.worldUuid, imported.worldUuid)
  const properties = await native('property/status', {})
  assert.equal(properties.serverNamespace, meta.serverId)
  const beforeIds = await worldIds()
  const sourceActors = JSON.parse(await readFile(join(root, '.local/playable-world/bank-actors.json'), 'utf8'))
  const visitorDigest = hash('controlled-mumbai-visitor:' + meta.serverId).slice(0, 32)
  const visitorId = [visitorDigest.slice(0, 8), visitorDigest.slice(8, 12), visitorDigest.slice(12, 16), visitorDigest.slice(16, 20), visitorDigest.slice(20)].join('-')
  const actor = activeCheck ? { name: 'MumbaiVisitor', principalId: visitorId, discordId: '770000000000000099' } : sourceActors.actors.bidder
  const name = actor.name || actor.minecraftUsername
  const access = JSON.parse(await readFile(join(meta.runtime, 'plugins/AgentCity/discord-game-access.json'), 'utf8'))
  const existing = Object.values(access.reservations || {}).find(value => value.playerName === name)
  await native('discord/reserve', { playerName: name, principalId: actor.principalId, discordId: actor.discordId || '770000000000000003', accountKind: 'local', expiresAtMs: Math.max(Date.now() + 3600000, Number(existing?.expiresAtMs || 0)) })
  bot = mineflayer.createBot({ host: '127.0.0.1', port: meta.gamePort, username: name, auth: 'offline', version: '1.21.11', hideErrors: true, checkTimeoutInterval: 120000 })
  bot.on('error', error => { report.clientError = error.message })
  bot.on('messagestr', message => { if (!/AC_SESSION/.test(message)) report.messages.push(message) })
  bot.on('physicsTick', () => { if (bot._client.state === 'play') bot._client.write('tick_end', {}) })
  bot.on('end', () => { disconnected = true })
  let timer
  try { await Promise.race([once(bot, 'spawn'), once(bot, 'kicked').then(([reason]) => { throw Error('MUMBAI_CLIENT_KICKED_' + JSON.stringify(reason)) }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('MUMBAI_SPAWN_TIMEOUT')), 45000) })]) }
  finally { clearTimeout(timer) }
  const playerId = bot._client.uuid
  const session = () => native('session?playerId=' + playerId)
  const pending = await poll(session, value => value.online && value.connectionId, 'SESSION')
  bot.chat('/mumbai')
  await delay(700)
  assert.notEqual((await session()).serverPosition.world, 'agentcity_mumbai')
  check('Unapproved connection cannot enter Mumbai')
  await native('discord/approve', { playerId, connectionId: pending.connectionId, principalId: actor.principalId })
  await poll(session, value => !value.pendingAuthentication && value.principalId === actor.principalId, 'APPROVAL')
  bot.chat('/lobby')
  await poll(session, value => value.serverPosition.world === 'agentcity_lobby' && value.serverGameMode === 'SURVIVAL', 'INITIAL_LOBBY')
  await delay(500)
  const beforeInventory = stable(inventory())
  if (!activeCheck) assert.equal(bot.inventory.items().filter(item => item.name === 'diamond_sword').length, 2, 'Copied bidder must retain both original swords')
  const before = await session()
  bot.chat('/mumbai')
  const arrival = await poll(session, value => value.serverPosition.world === 'agentcity_mumbai' && value.serverGameMode === 'ADVENTURE', 'MUMBAI')
  await bot.waitForChunksToLoad()
  assert.equal(stable(inventory()), beforeInventory)
  check('Approved visitor enters the imported world in Adventure with unchanged full client inventory', { arrival: arrival.serverPosition, inventorySha256: hash(beforeInventory) })
  const Vec3 = bot.entity.position.constructor, at = bot.entity.position.clone()
  const feet = at.floored(), floor = bot.blockAt(feet.offset(0, -1, 0))
  assert(floor && floor.name !== 'air' && floor.name !== 'water', 'Arrival has a real solid floor')
  bot._client.write('block_dig', { status: 0, location: floor.position, face: 1, sequence: 1 })
  bot._client.write('block_dig', { status: 2, location: floor.position, face: 1, sequence: 2 })
  await delay(700)
  assert.equal(bot.blockAt(floor.position).stateId, floor.stateId)
  await assert.rejects(native('escrow/preview', { operationId: randomUUID(), sellerId: actor.principalId, sellerAccountId: playerId,
    ownerPlayerId: playerId, sourceId: playerId, sourceKind: 'player_inventory', connectionId: pending.connectionId, slot: 0, count: 1 }), /escrow_close_container_survival_required/)
  check('Adventure dig cannot remove scenery and Mumbai inventory cannot enter native custody')
  let moved = false
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const candidate = feet.offset(dx * 2, 0, dz * 2)
    const lower = bot.blockAt(candidate), upper = bot.blockAt(candidate.offset(0, 1, 0)), support = bot.blockAt(candidate.offset(0, -1, 0))
    if (!lower || !upper || !support || lower.boundingBox !== 'empty' || upper.boundingBox !== 'empty' || support.boundingBox !== 'block') continue
    await bot.lookAt(new Vec3(candidate.x + 0.5, candidate.y + 1.6, candidate.z + 0.5), true)
    bot.setControlState('forward', true); await delay(650); bot.clearControlStates()
    if (bot.entity.position.distanceTo(at) > 0.2) { moved = true; break }
  }
  assert(moved, 'Visitor can move across actual loaded Mumbai blocks')
  check('Visitor walks through loaded native Mumbai terrain', { from: at, to: bot.entity.position.clone() })
  bot.chat('/lobby')
  const returned = await poll(session, value => value.serverPosition.world === 'agentcity_lobby' && value.serverGameMode === 'SURVIVAL', 'RETURN')
  await delay(500)
  assert.equal(stable(inventory()), beforeInventory)
  assert.equal(returned.principalId, before.principalId)
  assert.equal(returned.connectionId, before.connectionId)
  assert.deepEqual(await worldIds(), beforeIds)
  check('Lobby return restores Survival without inventory, principal, connection or prior-world UUID changes')
  report.status = 'pass'; report.serverId = meta.serverId; report.worldUuid = imported.worldUuid
  report.actor = { name, principalId: actor.principalId, playerId, controlled: true }
  report.worldIds = beforeIds
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  bot?.clearControlStates(); bot?.quit()
  report.sources = Object.fromEntries(await Promise.all(['plugin/src/main/java/org/agentcity/paper/MumbaiWorld.java', 'plugin/src/main/java/org/agentcity/paper/MumbaiWorldStorage.java', 'scripts/mumbai_host.py', 'tests/maps/mumbai-visit.mjs']
    .map(async path => [path, hash(await readFile(join(root, path)))])))
  const reportBytes = JSON.stringify(report, null, 2) + '\n'
  await writeFile(join(directory, 'report.json'), reportBytes)
  if (!activeCheck && report.status === 'pass') await writeFile(join(root, '.local/mumbai/isolated-verification.json'), JSON.stringify({ owner: 'agentcity-mumbai-isolated-proof', status: 'pass',
    pluginSha256: meta.pluginSha256, artifactManifestSha256: meta.artifactManifestSha256, worldUuid: meta.worldUuid, serverId: meta.serverId,
    report: 'evidence/runs/mumbai-visit/' + runId + '/report.json', reportSha256: hash(reportBytes) }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(directory, 'report.json'), error: report.error }))
}
