'use strict'

// Continue the retained TaskTester world. Never reset its platform or stock.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const { Vec3 } = require(path.join(root, 'tests/compatibility/node_modules/vec3'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { status: 'fail', scope: 'Read-only verification and empty-agent release after original shelter task completed; no rebuild, withdrawal or stock reset',
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
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
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
async function sourceCount(position) {
  await deadline(bot.pathfinder.goto(new goals.GoalNear(...position, 2)), 20000, 'Prepared source approach timed out')
  const chest = await deadline(bot.openChest(bot.blockAt(new Vec3(...position))), 5000, 'Source chest open timed out')
  try { return chest.containerItems().filter(item => item.name === 'oak_planks').reduce((total, item) => total + item.count, 0) }
  finally { await chest.close() }
}
async function run() {
  const { compileTaskPlan } = await import(pathToFileURL(path.join(root, 'backend/src/playable/task-tools.mjs')).href)
  const data = JSON.parse(await fs.readFile(path.join(root, '.local/playable-world/active.json'), 'utf8'))
  assert.equal(data.owner, 'agentcity-playable-pilot')
  assert.match(data.container, /^agentcity-playable-[a-f0-9]{8}$/)
  const runtime = path.join(root, '.local/playable-world', data.container)
  const token = (await fs.readFile(path.join(runtime, 'api-token'), 'utf8')).trim()
  const response = await fetch('http://127.0.0.1:25597/playable/status', { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const configuration = await response.json()
  const savedAgents = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agents.json'), 'utf8'))
  const savedSlot = savedAgents.agents.find(agent => agent.ownerName === 'TaskTester')
  assert.ok(!savedSlot || savedSlot.name === 'CityAgent2', 'Continue TaskTester only; never take Ruddy slot')
  assert.equal(savedAgents.agents.find(agent => agent.name === 'CityAgent1')?.ownerName, 'Ruddy')
  const region = configuration.taskRegions.find(value => value.slotName === 'CityAgent2')
  assert.ok(region)
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, version: '1.21.11', auth: 'offline', username: 'TaskTester', hideErrors: true, checkTimeoutInterval: 30000 })
  const world = packet => { worldName = packet.worldState?.name ?? worldName }
  bot._client.on('login', world); bot._client.on('respawn', world)
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  bot.on('error', error => { report.connectionError = error.message })
  bot.on('kicked', reason => { report.kicked = String(reason); disconnected = true })
  bot.on('end', () => { disconnected = true })
  await deadline(once(bot, 'spawn'), 45000, 'TaskTester login timeout')
  await command('/play', /Entered agentcity_play/)
  await poll(() => worldName, value => value === 'minecraft:agentcity_play', 'play world')
  assert.equal(bot.game.gameMode, 'survival')
  bot.loadPlugin(pathfinder)
  const movement = new Movements(bot)
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.scafoldingBlocks = []
  const min = region.min, max = region.max, sx = Math.floor(configuration.playSpawn.x), sz = Math.floor(configuration.playSpawn.z)
  const edge = sx < min.x ? min.x : max.x
  movement.exclusionAreasStep.push(block => {
    const p = block.position
    const pad = p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z
    const corridor = p.x >= Math.min(sx, edge) && p.x <= Math.max(sx, edge) && p.z >= sz - 1 && p.z <= sz + 1
    const spawn = Math.abs(p.x - sx) <= 2 && Math.abs(p.z - sz) <= 2
    return pad || corridor || spawn ? 0 : Infinity
  })
  bot.pathfinder.setMovements(movement)
  // Paper's same-IP login throttle also applies to a personal bot spawned just
  // after its owner connects. Keep the two native logins distinct.
  await delay(5000)
  await command('/agent create', /CityAgent2 is your personal agent/, 60000)
  const retainedState = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agent-tasks.json'), 'utf8'))
  const retainedTask = retainedState.tasks.filter(value => value.slotName === 'CityAgent2' && value.plan.action === 'build_shelter').at(-1)
  assert.ok(retainedTask && retainedTask.status === 'complete' && retainedTask.pending === null)
  const originalTaskId = retainedTask.id
  const withdrawal = retainedTask.receipts[retainedTask.operationId + ':withdraw']
  assert.ok(withdrawal)
  const before = withdrawal.before.chest.oak_planks, expectedSource = withdrawal.after.chest.oak_planks
  report.originalTaskId = originalTaskId
  await deadline(bot.pathfinder.goto(new goals.GoalNear(region.min.x + 1, region.min.y, region.origin[2] + 5, 0)), 20000, 'Outside south approach timed out')
  await deadline(bot.pathfinder.goto(new goals.GoalNear(region.min.x + 1, region.min.y, region.origin[2] - 1, 0)), 20000, 'Outside west approach timed out')
  report.outsidePerimeterPosition = bot.entity.position.clone()
  const plan = compileTaskPlan({ action: 'build_shelter', width: 4, depth: 4, material: 'oak_planks' }, region)
  assert.equal(plan.placements.length, 54)
  const preexisting = 4, missing = 50
  assert.ok(plan.placements.every(placement => bot.blockAt(new Vec3(...placement.position))?.name === 'oak_planks'))
  check('all54-real-shelter-blocks-observed-on-original-completed-task', { originalTaskId, retainedOldBlocks: preexisting, actualNewPlacements: missing })
  const after = await sourceCount(region.sourceChest)
  assert.equal(after, expectedSource); assert.equal(after, before - missing)
  check('actual-shelter-complete-with-exact50-new-survival-placements', { actualTemplateBlocks: 54, retainedOldBlocks: 4, sourcePlanksAfter: after, actualMaterialConsumption: before - after })
  const taskState = JSON.parse(await fs.readFile(path.join(runtime, 'personal-agent-tasks.json'), 'utf8'))
  const task = taskState.tasks.filter(task => task.slotName === 'CityAgent2' && task.plan.action === 'build_shelter').at(-1)
  assert.equal(task.id, originalTaskId); assert.equal(task.status, 'complete'); assert.equal(task.pending, null)
  assert.equal(task.completed.length, 54); assert.equal(task.preexisting.length, 4)
  assert.equal(Object.keys(task.receipts).length, 51)
  assert.equal(Object.keys(task.receipts).filter(value => value.endsWith(':withdraw')).length, 1)
  assert.equal(task.materialCount, 50)
  check('native-shelter-task-retains-one-withdrawal-and50-placement-receipts')
  const released = await command('/agent release', /was released|carrying items|reconcile/, 30000)
  if (/was released/.test(released)) check('empty-tasktester-agent-released-without-changing-ruddy-agent')
  else { report.releasePendingMaterialReconciliation = true; report.releaseResponse = released; throw Error('Shelter complete; agent release still requires material reconciliation.') }
  report.status = 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) { bot.pathfinder?.setGoal(null); bot.quit('Completed shelter verification finished') }
  report.finishedAt = new Date().toISOString(); report.lastWorldName = worldName
  if (process.env.AC_PLAYABLE_TEST_REPORT) { await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT), { recursive: true }); await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
})
