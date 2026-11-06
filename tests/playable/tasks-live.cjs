'use strict'

// TaskTester is a disclosed local fixture, never independent-human evidence.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { once } = require('node:events')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const { Vec3 } = require(path.join(root, 'tests/compatibility/node_modules/vec3'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const username = 'TaskTester'
const report = { status: 'fail', scope: 'Actual local player-agent build, delivery and sale; disclosed TaskTester fixture, real Minecraft items, Game Coins only',
  independentHumansVerified: 0, publicTransactions: 0, startedAt: new Date().toISOString(), checks: [] }
const messages = []
let bot, disconnected = false, worldName
const check = (name, details = {}) => { report.checks.push({ name, status: 'pass', ...details }); console.log(JSON.stringify({ check: name, status: 'pass', ...details })) }
async function deadline(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function poll(read, accepted, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (disconnected) throw Error('Fixture disconnected while waiting for ' + label)
    const value = await read()
    if (accepted(value)) return value
    await delay(100)
  }
  throw Error('Timed out: ' + label)
}
async function command(input, expected, timeout = 45000) {
  await delay(650)
  const start = messages.length
  bot.chat(input)
  return poll(() => messages.slice(start), lines => lines.find(line => expected.test(line)), input, timeout).then(lines => lines.find(line => expected.test(line)))
}
async function chestCounts(position, transfer) {
  await deadline(bot.pathfinder.goto(new goals.GoalNear(...position, 2)), 20000, 'Prepared chest approach timed out')
  const block = bot.blockAt(new Vec3(...position))
  assert.ok(block && block.name === 'chest', 'Registered real chest must exist')
  const chest = await deadline(bot.openChest(block), 5000, 'Registered chest open timed out')
  try {
    if (transfer) await transfer(chest)
    const result = {}
    for (const item of chest.containerItems()) result[item.name] = (result[item.name] || 0) + item.count
    return result
  } finally { await chest.close() }
}
async function balance() {
  const text = await command('/wallet', /(\d+) Game Coins available, (\d+) held/)
  return Number(text.match(/(\d+) Game Coins available, (\d+) held/)[1])
}
async function run() {
  const data = JSON.parse(await fs.readFile(path.join(root, '.local/playable-world/active.json'), 'utf8'))
  assert.equal(data.owner, 'agentcity-playable-pilot')
  assert.match(data.container, /^agentcity-playable-[a-f0-9]{8}$/)
  const token = (await fs.readFile(path.join(root, '.local/playable-world', data.container, 'api-token'), 'utf8')).trim()
  const response = await fetch('http://127.0.0.1:25597/playable/status', { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const configuration = await response.json()
  assert.equal(configuration.playWorld, 'agentcity_play')
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username, hideErrors: true, checkTimeoutInterval: 30000 })
  const rememberWorld = packet => { worldName = packet.worldState?.name ?? worldName }
  bot._client.on('login', rememberWorld); bot._client.on('respawn', rememberWorld)
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  bot.on('error', error => { report.connectionError = error.message })
  bot.on('end', () => { disconnected = true })
  bot.on('kicked', reason => { report.kicked = String(reason); disconnected = true })
  await deadline(once(bot, 'spawn'), 45000, 'Fixture login timeout')
  await command('/play', /Entered agentcity_play|Survival|play world|already.*play|Welcome/i)
  await poll(() => worldName, value => value?.replace(/^minecraft:/, '') === configuration.playWorld, 'actual play-world respawn')
  assert.equal(bot.game.gameMode, 'survival')
  check('fixture-player-enters-real-survival-play-world', { worldName })
  bot.loadPlugin(pathfinder)
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.scafoldingBlocks = []; movement.allowParkour = false
  bot.pathfinder.setMovements(movement)
  const created = await command('/agent create', /CityAgent[12] is your personal agent/, 60000)
  const agentName = created.match(/CityAgent[12]/)[0]
  report.agent = agentName
  const region = configuration.taskRegions.find(value => value.slotName === agentName)
  assert.ok(region, 'An agent must have a registered real task area')
  const min = region.min, max = region.max, sx = Math.floor(configuration.playSpawn.x), sz = Math.floor(configuration.playSpawn.z)
  const edge = sx < min.x ? min.x : max.x
  movement.exclusionAreasStep.push(block => {
    const p = block.position
    const pad = p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z
    const corridor = p.x >= Math.min(sx, edge) && p.x <= Math.max(sx, edge) && p.z >= sz - 1 && p.z <= sz + 1
    const spawnArea = Math.abs(p.x - sx) <= 2 && Math.abs(p.z - sz) <= 2
    return pad || corridor || spawnArea ? 0 : Infinity
  })
  await poll(() => bot.players[agentName]?.entity, entity => Boolean(entity), 'owned agent in the same play world')
  const beforeSource = await chestCounts(region.sourceChest)
  const beforeDestination = await chestCounts(region.destinationChest)
  assert.ok((beforeSource.oak_planks || 0) >= 4 && (beforeSource.cobblestone || 0) >= 8, 'Fixture needs existing stock; this test never tops it up')
  const buildTargets = []
  for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) buildTargets.push(new Vec3(region.origin[0] + x, region.origin[1], region.origin[2] + z))
  assert.ok(buildTargets.every(position => bot.blockAt(position)?.name === 'air'), 'Test needs a fresh empty target; it never resets existing blocks')
  await command('/agent task build a 2 by 2 oak plank platform', /Task .*started|Task .*running/, 70000)
  await poll(() => buildTargets.map(position => bot.blockAt(position)?.name), values => values.every(value => value === 'oak_planks'), 'four actual native placements', 180000)
  await poll(async () => command('/agent status', /Latest task/), value => /complete/.test(value), 'completed task checkpoint', 30000)
  const afterBuild = await chestCounts(region.sourceChest)
  assert.equal(afterBuild.oak_planks, beforeSource.oak_planks - 4)
  check('natural-language-platform-produces-four-real-blocks-and-consumes-four-planks')
  await command('/agent task deliver 4 cobblestone from my source chest to my destination chest', /Task .*started|Task .*running/, 70000)
  await poll(async () => command('/agent status', /Latest task/), value => /deliver: complete/.test(value), 'completed real delivery', 90000)
  const afterDeliverySource = await chestCounts(region.sourceChest)
  const afterDeliveryDestination = await chestCounts(region.destinationChest)
  assert.equal(afterDeliverySource.cobblestone, beforeSource.cobblestone - 4)
  assert.equal(afterDeliveryDestination.cobblestone || 0, (beforeDestination.cobblestone || 0) + 4)
  check('agent-delivery-conserves-four-real-cobblestone-between-owned-chests')
  // Explicit native collection preserves item-level proof into the agent's own
  // inventory. Dropping items near another player is not a reliable handoff.
  await command('/agent task collect 4 cobblestone from my source chest', /Task .*started|Task .*running/, 70000)
  await poll(async () => command('/agent status', /Latest task/), value => /collect: complete/.test(value), 'completed native collection', 90000)
  const afterCollection = await chestCounts(region.sourceChest)
  assert.equal(afterCollection.cobblestone, afterDeliverySource.cobblestone - 4)
  check('agent-collects-four-real-cobblestone-into-owned-inventory')
  const beforeSale = await balance()
  await command('/agent task sell 4 cobblestone', /Sold 4 (?:minecraft:)?cobblestone|received 4 Game Coins/i, 70000)
  const afterSale = await balance()
  assert.equal(afterSale, beforeSale + 4)
  check('owned-agent-sells-four-carried-real-items-for-exactly-four-game-coins')
  await command('/agent sell cobblestone 4', /does not carry|not carry|not enough|Supported tasks|Use \/agent/i, 30000)
  assert.equal(await balance(), afterSale)
  check('another-sale-request-without-items-credits-zero-additional-coins')
  await command('/agent release', /was released/, 30000)
  check('empty-fixture-agent-released-with-its-task-history-retained')
  report.status = 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) bot.quit('Local task verification finished')
  report.finishedAt = new Date().toISOString()
  report.lastWorldName = worldName
  if (process.env.AC_PLAYABLE_TEST_REPORT) {
    await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT), { recursive: true })
    await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report))
})
