'use strict'

// Authorized local TaskTester fixture only. No identity-provider login, crypto
// wallet provisioning, stock injection, world reset or second-human claim.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { once } = require('node:events')
const { createHash, randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '../..')
require(path.join(root, 'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const { Vec3 } = require(path.join(root, 'tests/compatibility/node_modules/vec3'))
const { Pool } = require(path.join(root, 'backend/node_modules/pg'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { status: 'fail', scope: 'Actual local @agent conversation through Ollama and native delivery/collection/Game Coins sale; crypto authentication remains denied for this synthetic player', independentHumansVerified: 0, providerIdentitiesVerified: 0, publicTransactions: 0, checks: [], startedAt: new Date().toISOString() }
const resuming = process.env.AC_CONVERSATION_RESUME === '1'
const verifying = process.env.AC_CONVERSATION_VERIFY === '1'
if (verifying) report.scope = 'Verify the retained completed conversational workflow using native chest observations and durable receiving receipts, then release its empty agent; no workflow or material effects repeated'
let bot, pool, disconnected = false, worldName
const messages = []
const check = (name, details = {}) => { report.checks.push({ name, status: 'pass', ...details }); console.log(JSON.stringify(report.checks.at(-1))) }
async function bounded(promise, milliseconds, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds) })]) } finally { clearTimeout(timer) } }
async function poll(read, accept, label, milliseconds = 30000) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) { if (disconnected) throw Error('Fixture disconnected: ' + label); const value = await read(); if (accept(value)) return value; await delay(200) }
  throw Error('Timed out: ' + label)
}
async function command(input, expected, milliseconds = 45000) {
  await delay(700); const start = messages.length; bot.chat(input)
  return (await poll(() => messages.slice(start), lines => lines.some(line => expected.test(line)), 'response for ' + input.split(' ')[0], milliseconds)).find(line => expected.test(line))
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
function preparedMovements(region, spawn) {
  const movements = new Movements(bot), sx = Math.floor(spawn.x), sz = Math.floor(spawn.z), edge = sx < region.min.x ? region.min.x : region.max.x
  movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.canOpenDoors = false; movements.scafoldingBlocks = []
  movements.entitiesToAvoid.add('player')
  movements.exclusionAreasBreak.push(() => Infinity); movements.exclusionAreasPlace.push(() => Infinity)
  movements.exclusionAreasStep.push(block => { const p = block.position; return p.x >= region.min.x && p.x <= region.max.x && p.z >= region.min.z && p.z <= region.max.z || p.x >= Math.min(sx, edge) && p.x <= Math.max(sx, edge) && Math.abs(p.z - sz) <= 1 || Math.abs(p.x - sx) <= 2 && Math.abs(p.z - sz) <= 2 ? 0 : Infinity })
  return movements
}
async function walk(position, label) { await bounded(bot.pathfinder.goto(new goals.GoalNear(...position, 0)), 20000, label); bot.pathfinder.setGoal(null) }
async function outsidePerimeter(region) {
  await walk([region.min.x + 1, region.min.y, region.origin[2] + 5], 'Bounded south perimeter approach')
  await walk([region.min.x + 1, region.min.y, region.origin[2] - 1], 'Bounded west perimeter approach')
}
async function countChest(position) {
  await bounded(bot.pathfinder.goto(new goals.GoalNear(...position, 2)), 20000, 'Bounded registered chest approach')
  const chest = await bounded(bot.openChest(bot.blockAt(new Vec3(...position))), 5000, 'Registered chest open')
  try { return chest.containerItems().filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0) } finally { await chest.close() }
}
async function coins() { const text = await command('/balance', /\d+ Game Coins available, \d+ held/); return Number(text.match(/(\d+) Game Coins available, (\d+) held/)[1]) }
async function providerRecords(playerId) {
  const available = (await pool.query("SELECT to_regclass('ac_playable_testnet_wallets') wallets,to_regclass('ac_playable_testnet_requests') requests,to_regclass('ac_playable_market_previews') previews")).rows[0]
  const counts = { wallets: 0, signingRequests: 0, swapPreviews: 0 }
  if (available.wallets) counts.wallets = (await pool.query("SELECT count(*)::int n FROM ac_playable_testnet_wallets WHERE wallet_id LIKE $1", ['%:' + playerId])).rows[0].n
  if (available.requests) counts.signingRequests = (await pool.query("SELECT count(*)::int n FROM ac_playable_testnet_requests WHERE wallet_id LIKE $1", ['%:' + playerId])).rows[0].n
  if (available.previews) counts.swapPreviews = (await pool.query('SELECT count(*)::int n FROM ac_playable_market_previews WHERE player_id=$1', [playerId])).rows[0].n
  return counts
}
async function run() {
  const active = await json(path.join(root, '.local/playable-world/active.json'))
  assert.equal(active.owner, 'agentcity-playable-pilot'); assert.match(active.container, /^agentcity-playable-[a-f0-9]{8}$/)
  const runtime = path.join(root, '.local/playable-world', active.container)
  const token = (await fs.readFile(path.join(runtime, 'api-token'), 'utf8')).trim()
  const api = async suffix => { const response = await fetch('http://127.0.0.1:25597/playable/' + suffix, { headers: { Authorization: 'Bearer ' + token } }); assert.equal(response.status, 200); return response.json() }
  const configuration = await api('status'), region = configuration.taskRegions.find(value => value.slotName === 'CityAgent2')
  assert(region); assert.equal(configuration.playWorld, 'agentcity_play')
  const beforeAgents = await json(path.join(runtime, 'personal-agents.json'))
  const ruddy = beforeAgents.agents.find(agent => agent.name === 'CityAgent1')
  assert.equal(ruddy?.ownerName, 'Ruddy')
  const existingSlot = beforeAgents.agents.find(agent => agent.name === 'CityAgent2')
  assert(verifying ? !existingSlot || existingSlot.ownerName === 'TaskTester' : resuming ? existingSlot?.ownerName === 'TaskTester' : !existingSlot, 'Only the free second slot or the explicitly retained TaskTester slot may be used')
  const retainedTasks = await json(path.join(runtime, 'personal-agent-tasks.json'))
  assert(retainedTasks.tasks.some(task => task.plan.action === 'build_shelter' && task.slotName === 'CityAgent2' && task.status === 'complete'))
  const conversationFile = path.join(runtime, 'agent-conversations.json')
  const fixtureOwnerId = existingSlot?.ownerId || retainedTasks.tasks.find(task => task.ownerName === 'TaskTester')?.ownerId
  const priorWorkflow = resuming || verifying ? (await json(conversationFile)).owners[fixtureOwnerId]?.workflow : null
  if (resuming) {
    assert.equal(priorWorkflow?.status, 'paused'); assert.equal(priorWorkflow.index, 0)
    const stoppedTask = retainedTasks.tasks.find(task => task.operationId === priorWorkflow.id + ':step:0')
    assert(stoppedTask && !stoppedTask.pending && Object.keys(stoppedTask.receipts).length === 0 && stoppedTask.completed.length === 0, 'This baseline resume fixture is safe only before any native effect; preserve partial effects for a separate reconciliation driver')
    report.resumedOriginalWorkflow = priorWorkflow.id
  }
  const settings = await json(path.join(root, '.local/backend/environment.json'))
  pool = new Pool({ connectionString: settings.databaseUrl, max: 1 })
  await delay(5000)
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, username: 'TaskTester', auth: 'offline', version: '1.21.11', hideErrors: true })
  bot._client.on('login', packet => { worldName = packet.worldState?.name || worldName }); bot._client.on('respawn', packet => { worldName = packet.worldState?.name || worldName })
  bot.on('messagestr', text => { if (!/AC_SESSION/.test(text)) messages.push(text) })
  bot.on('end', () => { disconnected = true }); bot.on('error', error => { report.connectionError = error.message })
  bot.on('kicked', () => { report.kicked = true; disconnected = true })
  await bounded(once(bot, 'spawn'), 45000, 'Fixture login')
  await command('/play', /Entered agentcity_play/)
  await poll(() => worldName, value => value === 'minecraft:agentcity_play', 'Protocol play-world identity')
  assert.equal(bot.game.gameMode, 'survival')
  const playerId = bot.player?.uuid || bot._client.uuid
  const session = await api('session?playerId=' + playerId)
  assert.equal(session.online, true); assert.match(session.connectionId, /^[a-f0-9-]{36}$/)
  if (verifying) {
    assert.equal(playerId, fixtureOwnerId); assert.equal(priorWorkflow.status, 'complete'); assert.equal(priorWorkflow.index, 3); assert.equal(priorWorkflow.receipts.length, 3)
    report.verifiedOriginalWorkflow = priorWorkflow.id
    const delivery = retainedTasks.tasks.find(task => task.operationId === priorWorkflow.id + ':step:0')
    const collection = retainedTasks.tasks.find(task => task.operationId === priorWorkflow.id + ':step:1')
    assert.equal(delivery.status, 'complete'); assert.equal(collection.status, 'complete'); assert.equal(delivery.pending, null); assert.equal(collection.pending, null)
    const withdrawn = delivery.receipts[delivery.operationId + ':withdraw'], deposited = delivery.receipts[delivery.operationId + ':deposit'], collected = collection.receipts[collection.operationId + ':withdraw']
    assert.equal(withdrawn.before.chest.cobblestone - withdrawn.after.chest.cobblestone, 2)
    assert.equal(deposited.after.chest.cobblestone - deposited.before.chest.cobblestone, 2)
    assert.equal(collected.before.chest.cobblestone - collected.after.chest.cobblestone, 4)
    assert.equal(withdrawn.after.chest.cobblestone, collected.before.chest.cobblestone)
    const saleHex = createHash('sha256').update('game-sale:' + priorWorkflow.id + ':step:2').digest('hex').slice(0, 32)
    const saleId = [saleHex.slice(0, 8), saleHex.slice(8, 12), saleHex.slice(12, 16), saleHex.slice(16, 20), saleHex.slice(20)].join('-')
    const sale = (await pool.query('SELECT * FROM ac_game_sales WHERE sale_id=$1 AND player_id=$2', [saleId, playerId])).rows[0]
    assert.equal(sale?.state, 'completed'); assert.equal(sale.item, 'minecraft:cobblestone'); assert.equal(sale.count, 4); assert.equal(String(sale.reward), '4'); assert.equal(sale.receipt.removed, true)
    assert.notEqual(sale.inventory_player_id, playerId)
    const ledger = (await pool.query('SELECT delta_available::text FROM ac_game_ledger WHERE operation_key=$1 AND player_id=$2', ['sale:' + saleId, playerId])).rows
    assert.equal(ledger.length, 1); assert.equal(ledger[0].delta_available, '4')
    check('original-three-step-workflow-has-complete-native-transfer-receipts-and-exactly-one-real-inventory-backed-four-coin-sale', { originalWorkflowId: priorWorkflow.id, sourceCobblestoneBefore: withdrawn.before.chest.cobblestone, sourceCobblestoneAfter: collected.after.chest.cobblestone, destinationBefore: deposited.before.chest.cobblestone, destinationAfter: deposited.after.chest.cobblestone, saleReward: '4', actualSaleLedgerEntries: 1 })
    if (existingSlot) await command('/agent release', /CityAgent2 was released/, 45000)
    const released = await json(path.join(runtime, 'personal-agents.json'))
    assert.equal(released.agents.length, 1); assert.deepEqual(released.agents[0], ruddy)
    check('completed-empty-agent-released-before-observer-approach-preserving-ruddy-agent')
    bot.loadPlugin(pathfinder); bot.pathfinder.setMovements(preparedMovements(region, configuration.playSpawn))
    await outsidePerimeter(region)
    const source = await countChest(region.sourceChest), destination = await countChest(region.destinationChest), balance = await coins()
    assert.equal(source, collected.after.chest.cobblestone); assert.equal(destination, deposited.after.chest.cobblestone)
    const records = await providerRecords(playerId); assert.deepEqual(records, { wallets: 0, signingRequests: 0, swapPreviews: 0 })
    const locks = await json(path.join(runtime, 'plugins/AgentCity/task-region-locks.json')); assert(!Object.keys(locks).some(key => key.includes('CityAgent2')))
    check('native-observer-confirms-retained-source-and-destination-stock-no-fixture-crypto-records-or-task-locks', { sourceCobblestone: source, destinationCobblestone: destination, gameCoins: balance, fixtureProviderRecords: records })
    report.status = 'pass'; return
  }
  const cryptoBefore = await providerRecords(playerId)
  const loginText = await command('/wallet', /player-wallet#challenge=[A-Za-z0-9_-]{43}/)
  const capability = loginText.match(/player-wallet#challenge=([A-Za-z0-9_-]{43})/)[1]
  const storedChallenge = (await pool.query('SELECT connection_id,consumed_at,expires_at FROM ac_wallet_login_challenges WHERE challenge_hash=$1', [createHash('sha256').update(capability).digest('hex')])).rows[0]
  assert(storedChallenge); assert.equal(storedChallenge.connection_id, session.connectionId); assert.equal(storedChallenge.consumed_at, null)
  await command('/swap 1 CITY GEM', /Sign in|login|required|not authenticated|not available/i)
  assert.deepEqual(await providerRecords(playerId), cryptoBefore)
  check('wallet-login-capability-binds-current-connection-and-unauthenticated-swap-adds-no-wallet-request-or-preview-records', { providerRecordsBefore: cryptoBefore, providerRecordsAfter: cryptoBefore })
  bot.loadPlugin(pathfinder); bot.pathfinder.setMovements(preparedMovements(region, configuration.playSpawn))
  await outsidePerimeter(region)
  const sourceBefore = await countChest(region.sourceChest), destinationBefore = await countChest(region.destinationChest), coinsBefore = await coins()
  assert(sourceBefore >= 6)
  await walk([region.min.x, region.min.y, region.origin[2] + 6], 'Observer park outside retained shelter')
  await delay(5000)
  await command('/agent create', /CityAgent2 is your personal agent/, 60000)
  const request = resuming ? '@agent Please resume my saved workflow with exactly the same steps.' : '@agent Please put a couple of cobblestone in my destination, then collect and sell four more for Game Coins.'
  await command(request, /Workflow accepted/, 150000)
  const initial = (await json(conversationFile)).owners[playerId]?.workflow
  assert(initial)
  if (resuming) assert.equal(initial.id, priorWorkflow.id)
  assert.deepEqual(initial.steps, [{ action: 'deliver', item: 'cobblestone', count: 2 }, { action: 'collect', item: 'cobblestone', count: 4 }, { action: 'sell', item: 'cobblestone', count: 4 }])
  report.workflowId = initial.id
  check('actual-at-agent-chat-produced-exact-three-step-conversational-plan', { steps: initial.steps })
  const completed = await poll(async () => (await json(conversationFile)).owners[playerId]?.workflow, workflow => workflow?.id === initial.id && ['complete', 'paused'].includes(workflow.status), 'Observed workflow completion', 180000)
  report.workflow = { status: completed.status, completedSteps: completed.index, totalSteps: completed.steps.length, message: completed.message }
  assert.equal(completed.status, 'complete', completed.message); assert.equal(completed.index, 3); assert.equal(completed.receipts.length, 3)
  assert.equal(await coins(), coinsBefore + 4)
  // The empty agent normally parks at the chest. Release it before asking an
  // observer whose player collision avoidance correctly excludes that stance.
  await command('/agent release', /CityAgent2 was released/, 45000)
  const afterAgents = await json(path.join(runtime, 'personal-agents.json'))
  assert.equal(afterAgents.agents.length, 1); assert.deepEqual(afterAgents.agents[0], ruddy)
  await outsidePerimeter(region)
  const sourceAfter = await countChest(region.sourceChest), destinationAfter = await countChest(region.destinationChest)
  assert.equal(sourceAfter, sourceBefore - 6); assert.equal(destinationAfter, destinationBefore + 2)
  check('native-delivery-collection-and-agent-inventory-sale-conserve-six-real-items-and-credit-exactly-four-game-coins', { sourceBefore, sourceAfter, destinationBefore, destinationAfter, coinsBefore, coinsAfter: coinsBefore + 4 })
  const afterTasks = await json(path.join(runtime, 'personal-agent-tasks.json'))
  const ownedTasks = afterTasks.tasks.filter(task => task.ownerId === playerId)
  assert.equal(ownedTasks.length, retainedTasks.tasks.filter(task => task.ownerId === playerId).length + (resuming ? 1 : 2))
  assert(ownedTasks.every(task => task.status === 'complete' && !task.pending))
  const locks = await json(path.join(runtime, 'plugins/AgentCity/task-region-locks.json')); assert(!Object.keys(locks).some(key => key.includes('CityAgent2')))
  check('empty-fixture-agent-released-original-history-and-ruddy-agent-retained-with-no-fixture-task-locks')
  report.status = 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  if (bot && !disconnected) { bot.pathfinder?.setGoal(null); bot.quit('Conversational fixture finished') }
  await pool?.end()
  report.finishedAt = new Date().toISOString(); report.lastWorldName = worldName
  // Never publish game-session capabilities or provider tokens in evidence.
  const sanitize = value => String(value).replace(/#challenge=[A-Za-z0-9_-]+/g, '#challenge=[REDACTED]')
  const publicReport = JSON.parse(sanitize(JSON.stringify(report)))
  const file = process.env.AC_PLAYABLE_TEST_REPORT || path.join(root, 'evidence/runs/playable-conversation', randomUUID(), 'report.json')
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(publicReport, null, 2) + '\n')
  console.log(JSON.stringify(publicReport)); console.log('Evidence ' + file)
})
