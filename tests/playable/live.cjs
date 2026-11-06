'use strict'

// Disclosed local fixture smoke. PlayTester is never an independent human proof.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { once } = require('node:events')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const username = process.env.AC_PLAYABLE_TEST_USER || 'PlayTester'
assert.match(username, /^[A-Za-z0-9_]{3,16}$/)
assert.ok(!['Ruddy', 'CityAgent1', 'CityAgent2', 'WorldBuilder', 'WorldRequester', 'WorldInspector'].includes(username), 'Use a dedicated fixture test player')
const report = { scope: 'local playable fixture; no independently verified human or blockchain action', username,
  status: 'fail', independentHumansVerified: 0, startedAt: new Date().toISOString(), checks: [] }
const messages = []
let bot, disconnected = false
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function poll(read, condition, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  let observed
  do {
    if (disconnected) throw Error('Test player disconnected while waiting for ' + label)
    observed = await read()
    if (condition(observed)) return observed
    await delay(100)
  } while (Date.now() < deadline)
  throw Error('Timed out waiting for ' + label)
}
function check(name, details = {}) {
  report.checks.push({ name, status: 'pass', ...details })
  console.log(JSON.stringify({ check: name, status: 'pass', ...details }))
}
async function chat(command, expected, timeout = 30000) {
  await delay(650)
  const start = messages.length
  bot.chat(command)
  return poll(() => messages.slice(start), lines => lines.some(line => expected.test(line)), command, timeout)
}
const namedNpcs = () => Object.values(bot.entities).filter(entity => entity.name === 'villager' || entity.type === 'villager')
const description = entity => JSON.stringify({ metadata: entity.metadata, name: entity.username, displayName: entity.displayName })
const inventory = () => bot.inventory.items().map(item => ({ name: item.name, count: item.count, slot: item.slot })).sort((a,b) => a.slot-b.slot)

async function run() {
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username,
    hideErrors: true, checkTimeoutInterval: 30000 })
  bot.on('error', error => { report.connectionError = error.message })
  bot.on('kicked', reason => { report.kicked = String(reason); disconnected = true })
  bot.on('end', () => { disconnected = true })
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  await Promise.race([once(bot, 'spawn'), delay(45000).then(() => { throw Error('Player login timed out') })])
  await poll(() => bot.game.gameMode, value => value === 'survival' || value === 0, 'Survival onboarding')
  check('fixture-player-joins-in-survival', { mode: bot.game.gameMode })
  const npcs = await poll(namedNpcs, entities => ['Guide','Agent Desk','Job Board','Game Coins'].every(name => entities.some(entity => description(entity).includes(name))), 'four named NPCs')
  check('four-clickable-npc-entities-visible', { npcNames: ['Guide','Agent Desk','Job Board','Game Coins'] })
  bot.loadPlugin(pathfinder)
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false
  bot.pathfinder.setMovements(movement)
  const guide = npcs.find(entity => description(entity).includes('Guide'))
  bot.pathfinder.setGoal(new goals.GoalNear(guide.position.x, guide.position.y, guide.position.z, 1))
  await poll(() => bot.entity.position.distanceTo(guide.position), distance => distance < 2, 'walk to Guide')
  bot.pathfinder.setGoal(null)
  await delay(250)
  report.guideInteraction = { playerPosition: bot.entity.position.clone(), npcPosition: guide.position.clone(), distance: bot.entity.position.distanceTo(guide.position) }
  const before = inventory()
  const opened = once(bot, 'windowOpen')
  await bot.activateEntityAt(guide, guide.position.offset(0,1,0))
  const [window] = await Promise.race([opened, delay(10000).then(() => { throw Error('Guide menu did not open') })])
  assert.ok(JSON.stringify(window.title).includes('Guide'))
  await bot.clickWindow(10,0,0)
  await delay(300)
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  assert.deepEqual(inventory(),before)
  check('guide-menu-opens-without-transferring-menu-items')
  await chat('/wallet', /100 Game Coins|100.*Game Coins.*available/)
  check('internal-wallet-shows-one-time100-game-coins')
  const created = await chat('/agent create', /CityAgent[12] is your personal agent/,45000)
  const text = created.find(line => /CityAgent[12] is your personal agent/.test(line))
  const name = text.match(/CityAgent[12]/)[0]
  report.agent = name
  await poll(() => bot.players[name]?.entity, entity => Boolean(entity), 'actual owned agent entity')
  check('personal-agent-created-and-visible', { agent: name })
  await chat('/agent status', new RegExp(name + ': online'))
  check('agent-status-confirms-live-connection')
  const agent = bot.players[name].entity
  const position = agent.position.clone()
  await chat('/agent follow', new RegExp(name + ' will follow you'))
  await poll(() => bot.players[name]?.entity?.position.distanceTo(position) ?? 0, distance => distance > 0.25, 'actual follow movement',20000)
  check('owned-agent-follows-with-actual-movement')
  await chat('/agent wait', new RegExp(name + ' stopped and is waiting'))
  check('owned-agent-waits-on-explicit-command')
  // Move the fixture player within the prepared hub so the model-selected come has work.
  bot.pathfinder.setGoal(new goals.GoalNear(38,81,7,1))
  await poll(() => bot.entity.position.distanceTo({x:38,y:81,z:7}), distance => distance < 2, 'fixture player destination')
  bot.pathfinder.setGoal(null)
  const comeStart = bot.players[name].entity.position.clone()
  await chat('/agent task come here', new RegExp(name + ' will come to you'),65000)
  await poll(() => bot.players[name]?.entity?.position.distanceTo(comeStart) ?? 0, distance => distance > 0.25, 'model-selected actual come movement',20000)
  check('natural-language-come-executes-after-local-model-selection')
  await chat('/agent wait', new RegExp(name + ' stopped and is waiting'))
  await chat('/agent release', new RegExp(name + ' was released'))
  check('empty-fixture-agent-released-with-owner-command')
  report.status = 'pass'
}

run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) bot.quit('Local fixture smoke complete')
  report.finishedAt = new Date().toISOString()
  if (process.env.AC_PLAYABLE_TEST_REPORT) {
    await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT), { recursive: true })
    await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT,JSON.stringify(report,null,2)+'\n')
  }
  console.log(JSON.stringify(report))
})
