'use strict'

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
const report = { status: 'fail', scope: 'Retained TaskTester native collection and agent-inventory sale; no world reset, stock grant, blockchain or independent-human claim',
  independentHumansVerified: 0, publicTransactions: 0, startedAt: new Date().toISOString(), checks: [] }
const messages = []
let bot, disconnected = false, worldName
const check = (name, details = {}) => { report.checks.push({ name, status: 'pass', ...details }); console.log(JSON.stringify({ check: name, status: 'pass', ...details })) }
async function deadline(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function poll(read, accept, label, timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (disconnected) throw Error('Fixture disconnected: ' + label)
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw Error('Timed out: ' + label)
}
async function command(input, expected, timeout = 45000) {
  await delay(650)
  const start = messages.length
  bot.chat(input)
  return poll(() => messages.slice(start), lines => lines.some(line => expected.test(line)), input, timeout).then(lines => lines.find(line => expected.test(line)))
}
function movements(region, spawn) {
  const m = new Movements(bot)
  m.canDig = false; m.allow1by1towers = false; m.allowParkour = false; m.scafoldingBlocks = []
  const min = region.min, max = region.max, sx = Math.floor(spawn.x), sz = Math.floor(spawn.z)
  const edge = sx < min.x ? min.x : max.x
  m.exclusionAreasStep.push(block => {
    const p = block.position
    const pad = p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z
    const corridor = p.x >= Math.min(sx, edge) && p.x <= Math.max(sx, edge) && p.z >= sz - 1 && p.z <= sz + 1
    const spawnArea = Math.abs(p.x - sx) <= 2 && Math.abs(p.z - sz) <= 2
    return pad || corridor || spawnArea ? 0 : Infinity
  })
  return m
}
async function sourceCount(position) {
  await deadline(bot.pathfinder.goto(new goals.GoalNear(...position, 2)), 20000, 'Prepared source approach timed out')
  const chest = await deadline(bot.openChest(bot.blockAt(new Vec3(...position))), 5000, 'Source chest open timed out')
  try { return chest.containerItems().filter(item => item.name === 'cobblestone').reduce((total, item) => total + item.count, 0) }
  finally { await chest.close() }
}
async function balance() {
  const text = await command('/wallet', /(\d+) Game Coins available, (\d+) held/)
  return Number(text.match(/(\d+) Game Coins available, (\d+) held/)[1])
}
async function run() {
  const data = JSON.parse(await fs.readFile(path.join(root, '.local/playable-world/active.json'), 'utf8'))
  assert.equal(data.owner, 'agentcity-playable-pilot')
  assert.match(data.container, /^agentcity-playable-[a-f0-9]{8}$/)
  const runtime = path.join(root, '.local/playable-world', data.container)
  const token = (await fs.readFile(path.join(runtime, 'api-token'), 'utf8')).trim()
  const response = await fetch('http://127.0.0.1:25597/playable/status', { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const configuration = await response.json()
  const agentsBefore = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agents.json'), 'utf8'))
  assert.equal(agentsBefore.agents.find(value => value.name === 'CityAgent1')?.ownerName, 'Ruddy')
  assert.equal(agentsBefore.agents.find(value => value.name === 'CityAgent2')?.ownerName, 'TaskTester')
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username: 'TaskTester', hideErrors: true, checkTimeoutInterval: 30000 })
  const world = packet => { worldName = packet.worldState?.name ?? worldName }
  bot._client.on('login', world); bot._client.on('respawn', world)
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  bot.on('error', error => { report.connectionError = error.message })
  bot.on('kicked', reason => { report.kicked = String(reason); disconnected = true })
  bot.on('end', () => { disconnected = true })
  await deadline(once(bot, 'spawn'), 45000, 'TaskTester login timeout')
  await command('/play', /Entered agentcity_play/)
  await poll(() => worldName, value => value === 'minecraft:agentcity_play', 'play-world protocol name')
  assert.equal(bot.game.gameMode, 'survival')
  assert.equal(bot.inventory.items().filter(item => item.name === 'cobblestone').reduce((total, item) => total + item.count, 0), 0, 'The earlier four-item handoff must have been returned, not silently lost')
  await command('/agent create', /CityAgent2 is your personal agent/, 60000)
  const region = configuration.taskRegions.find(value => value.slotName === 'CityAgent2')
  bot.loadPlugin(pathfinder); bot.pathfinder.setMovements(movements(region, configuration.playSpawn))
  const before = await sourceCount(region.sourceChest)
  assert.ok(before >= 4)
  const beforeCoins = await balance()
  check('retained-world-and-real-source-stock-observed-with-ruddy-agent-unchanged', { sourceCobblestoneBefore: before, coinsBefore: beforeCoins })
  await command('/agent task collect 4 cobblestone from my source chest', /Task .*started|Task .*running/, 70000)
  await poll(async () => command('/agent status', /Latest task/), text => /collect: complete/.test(text), 'actual collection completion', 90000)
  assert.equal(await sourceCount(region.sourceChest), before - 4)
  check('agent-collects-four-real-cobblestone-into-its-own-inventory')
  await command('/agent task sell 4 cobblestone', /Sold 4 (?:minecraft:)?cobblestone for 4 Game Coins/, 70000)
  assert.equal(await balance(), beforeCoins + 4)
  check('agent-native-inventory-sale-credits-exactly-four-game-coins', { coinsAfter: beforeCoins + 4 })
  await command('/agent task sell 4 cobblestone', /does not carry that many/, 70000)
  assert.equal(await balance(), beforeCoins + 4)
  check('new-sale-request-without-carried-stock-pays-zero-additional-coins')
  await command('/agent release', /CityAgent2 was released/, 30000)
  const agentsAfter = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agents.json'), 'utf8'))
  assert.equal(agentsAfter.agents.length, 1)
  assert.equal(agentsAfter.agents[0].ownerName, 'Ruddy')
  const taskState = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agent-tasks.json'), 'utf8'))
  assert.ok(taskState.tasks.some(task => task.plan.action === 'build_platform' && task.status === 'complete'))
  assert.ok(taskState.tasks.some(task => task.plan.action === 'deliver' && task.status === 'complete'))
  assert.ok(taskState.tasks.some(task => task.plan.action === 'collect' && task.status === 'complete'))
  check('empty-fixture-agent-released-and-all-real-task-history-preserved')
  report.status = 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) { bot.pathfinder?.setGoal(null); bot.quit('Retained collect/sale verification finished') }
  report.finishedAt = new Date().toISOString(); report.lastWorldName = worldName
  if (process.env.AC_PLAYABLE_TEST_REPORT) { await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT), { recursive: true }); await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
})
