'use strict'

// SaleTester is a disclosed fixture. Its items come from the existing, marked
// operator test-stock chest; this test never gives items or grants extra coins.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createRequire } = require('node:module')
const { once } = require('node:events')
const { randomUUID, createHash } = require('node:crypto')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const { Vec3 } = require(path.join(root, 'tests/compatibility/node_modules/vec3'))
const backendRequire = createRequire(path.join(root, 'backend/package.json'))
const { Pool } = backendRequire('pg')
const username = 'SaleTester'
const taskSlot = process.env.AC_PLAYABLE_TEST_SLOT || 'CityAgent2'
assert.ok(['CityAgent1', 'CityAgent2'].includes(taskSlot), 'Use a registered test slot')
const messages = []
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const redact = text => String(text).replace(/AC_SESSION\s+\S+\s+\S+/g, 'AC_SESSION <redacted>')
  .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<redacted-id>')
const reference = text => createHash('sha256').update(text).digest('hex')
const report = { scope: 'Actual local player inventory sale for Game Coins, using SaleTester and disclosed existing operator task-chest stock; no injected items, wallets, blockchain calls or independent-human claim',
  username, taskSlot, status: 'fail', startedAt: new Date().toISOString(), independentHumansVerified: 0, publicTransactions: 0,
  checks: [], commands: [] }
let bot, pool, disconnected = false, worldName

async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function poll(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  do {
    if (disconnected) throw Error('Sale fixture disconnected while waiting for ' + label)
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  } while (Date.now() < deadline)
  throw Error('Timed out: ' + label)
}
function check(name, details = {}) {
  report.checks.push({ name, status: 'pass', ...details })
  console.log(JSON.stringify({ check: name, status: 'pass', ...details }))
}
async function command(input, pattern) {
  await delay(650)
  const start = messages.length
  const record = { command: redact(input), replies: [] }
  report.commands.push(record)
  bot.chat(input)
  return poll(() => {
    const fresh = messages.slice(start)
    record.replies = fresh.map(redact)
    return fresh.find(line => pattern.test(line))
  }, Boolean, redact(input), 45000)
}
async function balance() {
  const named = /SaleTester: (\d+) Game Coins available, (\d+) held/
  let text = await command('/wallet', new RegExp(named.source + '|Welcome! You received your one-time 100 Game Coins starter grant'))
  if (!named.test(text)) text = await command('/wallet', named)
  const match = text.match(named)
  return { available: BigInt(match[1]), held: BigInt(match[2]) }
}
const carried = item => bot.inventory.items().filter(stack => stack.name === item).reduce((sum, stack) => sum + stack.count, 0)
async function treasury() {
  return (await pool.query("SELECT available::text,held::text FROM ac_game_shop_treasury WHERE id='shop'")).rows[0]
}
async function latestSale() {
  return (await pool.query(`SELECT s.sale_id,s.state,s.receipt,s.receiving_operation_id,s.item,s.count,s.reward::text
    FROM ac_game_sales s JOIN ac_game_players p ON p.player_id=s.player_id
    WHERE p.name_key='saletester' ORDER BY s.created_at DESC LIMIT 1`)).rows[0]
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
  const region = configuration.taskRegions.find(candidate => candidate.slotName === taskSlot)
  assert.ok(region && Array.isArray(region.sourceChest), 'A registered source chest is required')
  const settings = JSON.parse(await fs.readFile(path.join(root, '.local/backend/environment.json'), 'utf8'))
  pool = new Pool({ connectionString: settings.databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username,
    hideErrors: true, checkTimeoutInterval: 30000 })
  const remember = packet => { worldName = packet.worldState?.worldName ?? packet.worldState?.name ?? packet.worldName ?? worldName }
  bot._client.on('login', remember); bot._client.on('respawn', remember)
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  bot.on('error', error => { report.connectionError = redact(error.message) })
  bot.on('kicked', reason => { report.kicked = redact(typeof reason === 'string' ? reason : JSON.stringify(reason)); disconnected = true })
  bot.on('end', () => { disconnected = true })
  await bounded(once(bot, 'spawn'), 45000, 'Sale fixture login timed out')
  await command('/play', /Survival|agentcity_play|play world|already.*play|Welcome/i)
  await poll(() => worldName, value => value?.replace(/^minecraft:/, '') === configuration.playWorld, 'actual play-world transition')
  assert.equal(bot.game.gameMode, 'survival')
  check('sale-fixture-enters-real-survival-world')
  bot.loadPlugin(pathfinder)
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.scafoldingBlocks = []
  movement.canOpenDoors = false; movement.maxDropDown = 1
  const min = [region.min.x, region.min.y, region.min.z], max = [region.max.x, region.max.y, region.max.z]
  const spawnX = Math.floor(configuration.playSpawn.x), spawnZ = Math.floor(configuration.playSpawn.z)
  const approach = [spawnX < min[0] ? min[0] : max[0], min[1], spawnZ]
  // Stay on the prepared center corridor and this test slot's pad. A shorter
  // diagonal through untouched natural sand terrain is not a safe route.
  movement.exclusionAreasStep.push(block => {
    const p = block.position
    const pad = p.x >= min[0] && p.x <= max[0] && p.z >= min[2] && p.z <= max[2] && p.y >= min[1] - 1 && p.y <= max[1]
    const corridor = p.x >= Math.min(spawnX, approach[0]) && p.x <= Math.max(spawnX, approach[0]) &&
      p.z >= spawnZ - 1 && p.z <= spawnZ + 1 && p.y >= min[1] - 1 && p.y <= min[1] + 1
    const spawn = Math.abs(p.x - spawnX) <= 2 && Math.abs(p.z - spawnZ) <= 2 && p.y >= min[1] - 1 && p.y <= min[1] + 1
    return pad || corridor || spawn ? 0 : Infinity
  })
  bot.pathfinder.setMovements(movement)
  await bounded(bot.pathfinder.goto(new goals.GoalNear(...approach, 0)), 90000, 'Walking through the prepared corridor timed out')
  // The completed shelter occupies the interior. Approach around its west
  // perimeter instead of asking A* for a diagonal through a raised corner.
  const perimeter = [[min[0] + 1, min[1], spawnZ + 1], [min[0] + 1, min[1], min[2] + 1]]
  for (const point of perimeter) await bounded(bot.pathfinder.goto(new goals.GoalNear(...point, 0)), 90000, 'Walking around the completed shelter timed out')
  await bounded(bot.pathfinder.goto(new goals.GoalNear(...region.sourceChest, 2)), 90000, 'Walking to registered stock chest timed out')
  const block = bot.blockAt(new Vec3(...region.sourceChest))
  assert.equal(block?.name, 'chest')
  const beforeInventory = carried('oak_planks')
  const chest = await bot.openChest(block)
  let stockBefore, stockAfter
  try {
    stockBefore = chest.containerItems().filter(item => item.name === 'oak_planks').reduce((sum, item) => sum + item.count, 0)
    assert.ok(stockBefore >= 2, 'Existing operator test stock needs two planks; the test never replenishes it')
    await chest.withdraw(bot.registry.itemsByName.oak_planks.id, null, 2)
    stockAfter = chest.containerItems().filter(item => item.name === 'oak_planks').reduce((sum, item) => sum + item.count, 0)
  } finally { await chest.close() }
  await poll(() => carried('oak_planks'), count => count === beforeInventory + 2, 'native player withdrawal')
  assert.equal(stockAfter, stockBefore - 2)
  check('two-real-planks-withdrawn-from-existing-registered-test-stock', { stockBefore, stockAfter, inventoryBefore: beforeInventory, inventoryAfter: carried('oak_planks') })

  const balanceBefore = await balance()
  const shopBefore = await treasury()
  const carriedBefore = carried('oak_planks')
  await command('/sell oak_planks 2', /Sold 2 (?:minecraft:)?oak_planks for 4 Game Coins/i)
  await poll(() => carried('oak_planks'), count => count === carriedBefore - 2, 'authoritative native sale item removal')
  const balanceAfter = await balance()
  assert.equal(balanceAfter.available, balanceBefore.available + 4n)
  assert.equal(balanceAfter.held, balanceBefore.held)
  const paidSale = await latestSale()
  assert.equal(paidSale.state, 'completed'); assert.equal(paidSale.item, 'minecraft:oak_planks'); assert.equal(paidSale.count, 2)
  assert.equal(paidSale.receipt.removed, true)
  assert.equal(paidSale.receipt.operationId, paidSale.receiving_operation_id)
  report.saleReferenceSha256 = reference(paidSale.sale_id)
  const shopAfter = await treasury()
  assert.equal(BigInt(shopAfter.available), BigInt(shopBefore.available) - 4n)
  assert.equal(shopAfter.held, shopBefore.held)
  check('actual-two-item-removal-pays-four-coins-from-finite-shop-treasury', { before: String(balanceBefore.available), after: String(balanceAfter.available), treasuryBefore: shopBefore.available, treasuryAfter: shopAfter.available })

  await command('/sell retry ' + paidSale.sale_id, /already paid|No additional items or coins moved/i)
  assert.deepEqual(await balance(), balanceAfter)
  assert.equal(carried('oak_planks'), carriedBefore - 2)
  assert.deepEqual(await treasury(), shopAfter)
  check('same-sale-retry-removes-zero-extra-items-and-pays-zero-extra-coins')

  const remaining = carried('oak_planks')
  assert.ok(remaining < 64, 'Fixture needs room for a bounded insufficient-items request; the test never discards inventory')
  await command('/sell oak_planks ' + (remaining + 1), /Sale cancelled after confirmed no item removal|No coins were paid/i)
  const cancelled = await latestSale()
  assert.notEqual(cancelled.sale_id, paidSale.sale_id)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.receipt.removed, false)
  assert.deepEqual(await balance(), balanceAfter)
  assert.equal(carried('oak_planks'), remaining)
  assert.deepEqual(await treasury(), shopAfter)
  check('insufficient-items-receipt-cancels-without-coins-items-or-reservation-leak')
  report.status = 'pass'
}

run().catch(error => { report.error = redact(error.message); process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) bot.quit('Local physical sale verification complete')
  if (pool) await pool.end()
  report.finishedAt = new Date().toISOString()
  const output = process.env.AC_PLAYABLE_TEST_REPORT || path.join(root, 'evidence/runs/playable-sales', randomUUID(), 'report.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
})
