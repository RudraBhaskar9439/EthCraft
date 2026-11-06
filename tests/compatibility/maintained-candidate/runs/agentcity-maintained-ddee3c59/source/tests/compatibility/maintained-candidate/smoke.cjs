'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '../../..')
const modules = path.join(root, 'tests/compatibility/node_modules')
const mineflayer = require(path.join(modules, 'mineflayer'))
const { ConstructionWorker } = require(path.join(root, 'backend/src/bot/construction-worker.cjs'))
const { MinecraftAdapter, bounded } = require(path.join(root, 'backend/src/bot/minecraft-adapter.cjs'))
const runtime = process.env.AC_CANDIDATE_RUNTIME
const token = process.env.AC_CANDIDATE_TOKEN
const clients = []
const sessions = new Map()
const secrets = new Set([token])
const report = { status: 'fail', scope: 'isolated non-token maintained candidate smoke; no adoption', clientVersion: '1.21.11', scriptedPlayers: true, independentHumans: 0, checks: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const uuid = name => {
  const bytes = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
const observation = async () => JSON.parse(await fs.readFile(path.join(runtime, 'construction-observation.json'), 'utf8'))
async function status () {
  const response = await fetch('http://127.0.0.1:25597/status', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  return response.json()
}
async function connect (name) {
  if (clients.length) await delay(4200)
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, username: name, auth: 'offline', version: '1.21.11', hideErrors: true })
  clients.push(bot)
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (packet, data) => {
    if (['position', 'position_look', 'look', 'flying'].includes(packet)) {
      report.movement ??= []
      const nonfinite = ['x', 'y', 'z', 'yaw', 'pitch'].filter(field => field in data && !Number.isFinite(data[field]))
      if (nonfinite.length || report.movement.length < 12) report.movement.push({ player: name, packet, data: { ...data }, nonfinite })
    }
    return write(packet, data)
  }
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'position') {
      report.serverPositions ??= []
      if (report.serverPositions.length < 6) report.serverPositions.push({ player: name, data })
    }
  })
  bot.on('kicked', reason => { report.connectionError = name + ': ' + JSON.stringify(reason) })
  bot.on('messagestr', message => {
    const parts = message.trim().split(/\s+/)
    if (parts[0] === 'AC_SESSION' && parts[1] === uuid(name)) { sessions.set(name, parts[2]); secrets.add(parts[2]) }
  })
  await bounded(new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('error', reject)
    bot.once('kicked', reason => reject(new Error(name + ': kicked: ' + JSON.stringify(reason))))
  }), 30000, 'translated_client_login_timeout')
  bot.on('error', error => { report.connectionError = error.message })
  await bounded(bot.waitForChunksToLoad(), 20000, 'translated_chunks_timeout')
  for (let attempt = 0; attempt < 50 && !sessions.has(name); attempt++) await delay(100)
  assert.ok(sessions.has(name), 'Plugin scoped session must reach translated client.')
  assert.equal(bot.player?.uuid || bot.entity?.uuid || bot._client?.uuid, uuid(name))
  return bot
}

async function run () {
  const plan = JSON.parse(await fs.readFile(path.join(runtime, 'construction-fixture.json'), 'utf8'))
  const builder = await connect('WorldBuilder')
  const requester = await connect('WorldRequester')
  await connect('WorldInspector')
  report.checks.push({ name: 'three-translated-1.21.11-logins-and-scoped-sessions', status: 'pass' })
  const origin = plan.deployment.plotMin.map((value, index) => value + [4, 1, 4][index])
  const bounds = plan.construction_access.navigation_bounds_relative
  const options = bot => ({ bot, deployment: plan.deployment, apiUrl: 'http://127.0.0.1:25597', apiToken: token,
    session: sessions.get(bot.username), dependencyRoot: modules, constructionAccess: plan.construction_access,
    accessBounds: { min: bounds.min.map((value, index) => value + origin[index]), max: bounds.max.map((value, index) => value + origin[index]) } })
  const adapter = new MinecraftAdapter(options(builder))
  const worker = new ConstructionWorker({ adapter, blueprint: plan.blueprint, blueprintSha256: plan.deployment.blueprintSha256,
    deployment: plan.deployment, checkpointPath: path.join(runtime, 'candidate-checkpoint.json') })
  const before = await observation()
  assert.equal(Object.values(before.stock).reduce((a, b) => a + b, 0), 144)
  for (const placement of worker.placements) assert.equal(before.blocks[placement.key] || 'minecraft:air', 'minecraft:air')
  report.checks.push({ name: 'real-fresh-block-and-exact-stock-read', status: 'pass', circuitBlocks: 0, stock: 144 })
  const outcome = await worker.run({ maxPlacements: 1 })
  report.worker = outcome
  report.lastNavigation = adapter.lastNavigation
  assert.equal(outcome.status, 'checkpointed', JSON.stringify(outcome))
  assert.equal(outcome.completed, 1)
  await delay(500)
  const checkpoint = JSON.parse(await fs.readFile(path.join(runtime, 'candidate-checkpoint.json'), 'utf8'))
  const placed = worker.placements.find(placement => placement.key === checkpoint.completed[0])
  const after = await observation()
  const remaining = Object.values(after.stock).reduce((a, b) => a + b, 0) + Object.values(after.players.WorldBuilder.items).reduce((a, b) => a + b, 0)
  assert.equal(remaining, 143)
  assert.equal(builder.blockAt(new adapter.Vec3(...placed.position)).name, placed.block.slice('minecraft:'.length))
  report.checks.push({ name: 'receipted-native-placement-and-one-item-consumption', status: 'pass', operationId: checkpoint.receipts.find(receipt => receipt.action === 'PLACE').operationId, target: placed.position, remaining })
  await adapter.goViaAccessRoute([plan.deployment.chest[0], plan.deployment.chest[1], plan.deployment.chest[2] - 1])
  const requesterAdapter = new MinecraftAdapter(options(requester))
  const relative = placed.position.map((value, index) => value - origin[index]).join(',')
  await requesterAdapter.goViaAccessRoute(plan.construction_access.stances[relative].map((value, index) => value + origin[index]))
  const prior = await status()
  const block = requester.blockAt(new adapter.Vec3(...placed.position))
  assert.ok(requester.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) < 4.5)
  try { await bounded(requester.dig(block), 15000, 'protected_dig_did_not_acknowledge') } catch (error) { report.protectedDigResult = error.message }
  requester.stopDigging()
  await delay(500)
  const protectedState = await status()
  const protectedObservation = await observation()
  assert.equal(protectedState.state.revision, prior.state.revision)
  assert.equal(protectedObservation.blocks[placed.key], after.blocks[placed.key])
  assert.ok(protectedState.refusals.slice(prior.refusals.length).includes('break_not_authorized'), 'The unchanged protection plugin must record refusal of the actual native dig.')
  report.checks.push({ name: 'actual-unauthorized-native-break-refused-without-world-or-revision-change', status: 'pass', target: placed.position })
  const native = JSON.parse(await fs.readFile(path.join(runtime, 'maintained-native-probe.json'), 'utf8'))
  report.nativeLever = native
  assert.equal(native.status, 'pass', JSON.stringify(native))
  report.checks.push({ name: 'candidate-plugin-native-lever-path-toggles-and-restores', status: 'pass' })
  report.status = 'pass'
}

run().catch(error => { report.error = { name: error.name, message: error.message }; process.exitCode = 1 }).finally(async () => {
  for (const client of clients) { try { client.quit() } catch {} }
  await delay(1000)
  let encoded = JSON.stringify(report, null, 2)
  for (const secret of secrets) if (secret) encoded = encoded.split(secret).join('<redacted-credential>')
  await fs.writeFile(process.env.AC_CANDIDATE_REPORT, encoded + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error }))
})
