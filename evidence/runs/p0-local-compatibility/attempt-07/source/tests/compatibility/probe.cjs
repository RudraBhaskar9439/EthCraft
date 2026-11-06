'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const port = Number(process.env.AC_COMPAT_PORT || 25576)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'AC_COMPAT_PORT must be a valid integer port')

const controller = new AbortController()
const clients = []
let closing = false
const report = {
  schema: 'agentcity.p0.compatibility.v1',
  status: 'failed',
  started_at: new Date().toISOString(),
  environment: { host: '127.0.0.1', port, version: '1.21.11', auth: 'offline' },
  identities: 'FixtureBuilder and FixtureObserver are both agent-controlled test fixtures, not independent humans or licensed-account proof.',
  steps: []
}

function abort (error) {
  if (!closing && !controller.signal.aborted) controller.abort(error)
}

async function bounded (operation, label, timeout = 5000) {
  if (controller.signal.aborted) throw controller.signal.reason
  let timer
  let onAbort
  const failure = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeout} ms`)), timeout)
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, failure])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

function connect (username) {
  const bot = mineflayer.createBot({
    host: '127.0.0.1', port, username, version: '1.21.11', auth: 'offline'
  })
  const client = { bot, ended: false }
  clients.push(client)
  bot.on('error', error => abort(new Error(`${username}: ${error.message}`)))
  bot.on('kicked', reason => abort(new Error(`${username}: kicked: ${String(reason)}`)))
  bot.on('end', reason => {
    client.ended = true
    abort(new Error(`${username}: disconnected: ${String(reason)}`))
  })
  return bounded(new Promise(resolve => bot.once('spawn', () => resolve(bot))), `${username} spawn`, 12000)
}

function position (bot, x, y, z) {
  return bot.entity.position.offset(x - bot.entity.position.x, y - bot.entity.position.y, z - bot.entity.position.z)
}

function block (bot, x, y, z, name) {
  const observed = bot.blockAt(position(bot, x, y, z))
  assert.ok(observed, `${bot.username}: missing block observation at ${x},${y},${z}`)
  assert.equal(observed.name, name, `${bot.username}: block at ${x},${y},${z}`)
  return observed
}

async function observe (bot) {
  let listener
  const reply = new Promise((resolve, reject) => {
    listener = message => {
      if (message.startsWith('AC_COMPAT_ERROR')) return reject(new Error(message))
      if (!message.startsWith('AC_COMPAT ')) return
      try {
        const data = JSON.parse(message.slice('AC_COMPAT '.length))
        assert.ok(Array.isArray(data.builder_position) && data.builder_position.length === 3 && data.builder_position.every(Number.isInteger), 'plugin must report authoritative builder position')
        assert.equal(typeof data.lever, 'boolean')
        assert.equal(typeof data.lamp, 'boolean')
        assert.ok(Number.isInteger(data.wire) && data.wire >= 0 && data.wire <= 15)
        assert.ok(Number.isInteger(data.stock) && data.stock >= 0)
        assert.ok(['AIR', 'COBBLESTONE'].includes(data.target))
        assert.equal(typeof data.server, 'string')
        assert.ok(data.server.includes('1.21.11'), 'plugin must report the pinned server version')
        assert.equal(data.plugin, '0.1.0')
        resolve(data)
      } catch (error) {
        reject(error)
      }
    }
    bot.on('messagestr', listener)
    bot.chat('/compat observe')
  })
  try {
    return await bounded(reply, `${bot.username} plugin observation`)
  } finally {
    bot.removeListener('messagestr', listener)
  }
}

async function verifyState (bots, expected, label) {
  report.current_step = label
  const readings = await Promise.all(bots.map(observe))
  report.last_readings = readings
  assert.deepEqual(readings[0], readings[1], 'fixture clients must observe the same authoritative state')
  for (const [key, value] of Object.entries(expected)) assert.equal(readings[0][key], value, `${label}: plugin ${key}`)
  for (const bot of bots) {
    assert.equal(block(bot, 1, 81, 0, 'lever').getProperties().powered, expected.lever, `${label}: client lever`)
    // This protocol exposes wire power as an enum string, while Bukkit reports an integer.
    assert.equal(String(block(bot, 2, 81, 0, 'redstone_wire').getProperties().power), String(expected.wire), `${label}: client wire`)
    assert.equal(block(bot, 3, 81, 0, 'redstone_lamp').getProperties().lit, expected.lamp, `${label}: client lamp`)
    block(bot, 2, 81, 2, expected.target.toLowerCase())
  }
  report.steps.push({ name: label, passed: true, observations: readings, client_blocks: bots.map(bot => ({
    player: bot.username,
    lever: block(bot, 1, 81, 0, 'lever').getProperties(),
    wire: block(bot, 2, 81, 0, 'redstone_wire').getProperties(),
    lamp: block(bot, 3, 81, 0, 'redstone_lamp').getProperties()
  })) })
  return readings[0]
}

function itemCount (items, type) {
  return items.filter(item => item.type === type).reduce((sum, item) => sum + item.count, 0)
}

async function settle (bots) {
  await bounded(Promise.all(bots.map(bot => bot.waitForTicks(10))), 'ten fixture settling ticks')
}

async function run () {
  const builder = await connect('FixtureBuilder')
  // Respect Paper's per-address connection throttle for two local fixture clients.
  await bounded(builder.waitForTicks(100), 'connection throttle spacing', 7000)
  const bots = [builder, await connect('FixtureObserver')]
  await bounded(Promise.all(bots.map(bot => bot.waitForChunksToLoad())), 'fixture chunk loading', 10000)
  assert.equal(builder.game.gameMode, 'survival')
  assert.equal(bots[1].game.gameMode, 'survival')
  const cobblestone = builder.registry.itemsByName.cobblestone.id
  assert.equal(itemCount(builder.inventory.items(), cobblestone), 0, 'fixture builder must start without cobblestone')
  await settle(bots)
  const off = { lever: false, lamp: false, wire: 0, stock: 2, target: 'AIR' }
  await verifyState(bots, off, 'initial_off')

  await bounded(builder.activateBlock(block(builder, 1, 81, 0, 'lever')), 'activate lever')
  await settle(bots)
  await verifyState(bots, { ...off, lever: true, lamp: true, wire: 15 }, 'lever_on')
  await bounded(builder.activateBlock(block(builder, 1, 81, 0, 'lever')), 'deactivate lever')
  await settle(bots)
  await verifyState(bots, off, 'lever_off_again')

  report.current_step = 'withdraw_one_actual_item'
  const chest = await bounded(builder.openContainer(block(builder, 0, 81, 2, 'chest')), 'open fixture chest')
  try {
    assert.equal(itemCount(chest.containerItems(), cobblestone), 2, 'real chest must contain two items')
    await bounded(chest.withdraw(cobblestone, null, 1), 'withdraw one cobblestone')
    assert.equal(itemCount(chest.containerItems(), cobblestone), 1, 'real chest must lose exactly one item')
    assert.equal(itemCount(chest.items(), cobblestone), 1, 'active player inventory must receive exactly one item')
  } finally {
    await bounded(chest.close(), 'close fixture chest')
  }
  await settle(bots)
  assert.equal(itemCount(builder.inventory.items(), cobblestone), 1, 'closed-window player inventory must retain exactly one item')
  await verifyState(bots, { ...off, stock: 1 }, 'one_item_withdrawn')
  const held = builder.inventory.items().find(item => item.type === cobblestone)
  assert.ok(held, 'withdrawn item must exist before placement')
  await bounded(builder.equip(held, 'hand'), 'equip withdrawn item')
  const support = block(builder, 2, 80, 2, 'stone')
  const topFace = support.position.offset(0, 1, 0).minus(support.position)
  assert.deepEqual([topFace.x, topFace.y, topFace.z], [0, 1, 0])
  await bounded(builder.placeBlock(support, topFace), 'place actual withdrawn item')
  await settle(bots)
  assert.equal(itemCount(builder.inventory.items(), cobblestone), 0, 'placement must consume the withdrawn item')
  const placed = { ...off, stock: 1, target: 'COBBLESTONE' }
  await verifyState(bots, placed, 'one_item_consumed_in_world')

  report.current_step = 'bounded_navigation'
  builder.loadPlugin(pathfinder)
  const movements = new Movements(builder)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.maxDropDown = 0
  movements.scafoldingBlocks = []
  movements.exclusionAreasBreak.push(() => 100)
  movements.exclusionAreasPlace.push(() => 100)
  movements.exclusionAreasStep.push(candidate => {
    const p = candidate.position
    return p.x < -3 || p.x > 5 || p.z < -3 || p.z > 5 || p.y < 80 || p.y > 83 ? 100 : 0
  })
  builder.pathfinder.setMovements(movements)
  const before = builder.entity.position.clone()
  await bounded(builder.pathfinder.goto(new goals.GoalNear(-2, 81, 0, 0)), 'bounded pathfinder navigation', 10000)
  const after = builder.entity.position.floored()
  assert.deepEqual([after.x, after.y, after.z], [-2, 81, 0], 'bot must reach the actual navigation goal')
  assert.ok(builder.entity.position.distanceTo(before) > 1, 'bot must actually move')
  await builder.waitForTicks(3)
  const authoritative = await observe(observer)
  assert.deepEqual(authoritative.builder_position, [-2, 81, 0], 'Paper must confirm the actual navigation goal, not only the local client')
  report.steps.push({ name: 'bounded_navigation', passed: true, before, after, server_position: authoritative.builder_position, can_dig: false, scaffold_items: 0 })
  await verifyState(bots, placed, 'world_unchanged_after_navigation')
  report.status = 'passed'
  delete report.current_step
}

const overall = setTimeout(() => abort(new Error('Overall compatibility probe exceeded 60000 ms')), 60000)
run().catch(error => {
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
}).finally(async () => {
  closing = true
  clearTimeout(overall)
  for (const { bot, ended } of clients) {
    if (ended) continue
    try {
      if (bot.pathfinder) bot.pathfinder.stop()
      bot.clearControlStates()
      bot.quit('AgentCity compatibility fixture finished')
    } catch {
      bot.end('AgentCity compatibility fixture cleanup')
    }
  }
  report.finished_at = new Date().toISOString()
  if (process.env.AC_COMPAT_REPORT) {
    const destination = path.resolve(process.env.AC_COMPAT_REPORT)
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      report.status = 'failed'
      report.error = { name: error.name, message: `Evidence write failed: ${error.message}` }
      process.exitCode = 1
    }
  }
  console.log(JSON.stringify(report))
  // A failed network library cleanup must not leave this bounded fixture process hanging.
  setTimeout(() => process.exit(process.exitCode || 0), 1000).unref()
})
