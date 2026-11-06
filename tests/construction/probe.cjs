'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const dependencyRoot = process.env.AC_CONSTRUCTION_DEPENDENCY_ROOT
const sourceRoot = process.env.AC_CONSTRUCTION_SOURCE_ROOT
const mineflayer = require(path.join(dependencyRoot, 'mineflayer'))
const { ConstructionWorker, structural } = require(path.join(sourceRoot, 'backend/src/bot/construction-worker.cjs'))
const { MinecraftAdapter, bounded } = require(path.join(sourceRoot, 'backend/src/bot/minecraft-adapter.cjs'))
const runtime = process.env.AC_CONSTRUCTION_RUNTIME
const token = process.env.AC_CONSTRUCTION_TOKEN
const phase = process.env.AC_CONSTRUCTION_PHASE
const internal = process.env.AC_CONSTRUCTION_INTERNAL === 'true'
const clients = []
const sessions = new Map()
const secrets = new Set([token])
const report = { schema: 'agentcity.p2.construction-client.v1', phase, status: 'fail', started_at: new Date().toISOString(), independent_humans: 0, scripted_roles: true, checks: [], live0GVerified: false, spending: 0 }
let closing = false
let lastPost = 0
let lastConnect = 0
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const offlineUuid = name => {
  const bytes = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
function clean (value) {
  let encoded = JSON.stringify(value)
  for (const secret of secrets) if (secret) encoded = encoded.split(secret).join('<redacted-credential>')
  return JSON.parse(encoded)
}
async function poll (read, acceptable, label, milliseconds = 5000) {
  const until = performance.now() + milliseconds
  let observed
  do {
    observed = await read()
    if (acceptable(observed)) return observed
    await delay(100)
  } while (performance.now() < until)
  throw new Error('Timed out: ' + label)
}
function check (name, details) {
  report.checks.push({ name, ...details, status: 'pass', at: new Date().toISOString() })
  console.log(JSON.stringify({ check: name, status: 'pass' }))
}
async function connect (name) {
  await delay(Math.max(0, 4200 - (performance.now() - lastConnect)))
  lastConnect = performance.now()
  const options = { host: '127.0.0.1', port: Number(process.env.AC_CONSTRUCTION_GAME_PORT), username: name, auth: 'offline', version: '1.21.11', hideErrors: true, checkTimeoutInterval: 30000 }
  const bot = process.env.AGENTCITY_MINECRAFT_PROFILE === 'maintained'
    ? require(path.join(sourceRoot, 'backend/src/bot/client-protocol.cjs')).createMaintainedBot(mineflayer, options, runtime)
    : mineflayer.createBot(options)
  clients.push(bot)
  bot.on('messagestr', message => {
    const parts = message.trim().split(/\s+/)
    if (parts.length === 3 && parts[0] === 'AC_SESSION' && parts[1] === offlineUuid(name)) { sessions.set(name, parts[2]); secrets.add(parts[2]) }
  })
  bot.on('error', error => { if (!closing) report.connection_error = `${name}: ${error.message}` })
  const kickReason = reason => typeof reason === 'string' ? reason : JSON.stringify(reason)
  bot.on('kicked', reason => { if (!closing) report.connection_error = `${name}: kicked: ${kickReason(reason)}` })
  let cleanupSpawn
  try {
    await bounded(new Promise((resolve, reject) => {
      const spawned = () => resolve()
      const kicked = reason => reject(new Error(`${name}: kicked before spawn: ${kickReason(reason)}`))
      const ended = reason => reject(new Error(`${name}: disconnected before spawn: ${String(reason)}`))
      const failed = error => reject(new Error(`${name}: connection failed: ${error.message}`))
      cleanupSpawn = () => { bot.removeListener('spawn', spawned); bot.removeListener('kicked', kicked); bot.removeListener('end', ended); bot.removeListener('error', failed) }
      bot.once('spawn', spawned); bot.once('kicked', kicked); bot.once('end', ended); bot.once('error', failed)
    }), 15000, name + '_SPAWN_TIMEOUT')
  } finally { cleanupSpawn?.() }
  await bounded(bot.waitForChunksToLoad(), 10000, name + '_CHUNKS_TIMEOUT')
  await poll(async () => sessions.get(name), Boolean, name + ' authenticated fixture session')
  const actualUuid = bot.player?.uuid || bot.entity?.uuid || bot._client.uuid
  assert.equal(actualUuid, offlineUuid(name), 'server player must match configured fixture identity')
  bot.uuid = actualUuid
  lastConnect = performance.now()
  return bot
}
async function state () {
  const response = await fetch(`http://127.0.0.1:${process.env.AC_CONSTRUCTION_HTTP_PORT}/status`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  return (await response.json()).state
}
async function observation () {
  // Docker Desktop replacement can briefly hide a shared file from WSL readers.
  // Require a real complete observation; never synthesize or reuse stale state.
  const deadline = performance.now() + 1000
  while (true) {
    try { return JSON.parse(await fs.readFile(path.join(runtime, 'construction-observation.json'), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error
      await delay(25)
    }
  }
}
async function retainNavigation (adapter) {
  report.last_navigation = JSON.parse(JSON.stringify(adapter.lastNavigation ?? null))
  const previousTick = (await observation()).tick
  report.waiting_observation = await poll(observation, value => value.tick > previousTick,
    'fresh authoritative observation before waiting assertion and cleanup', 5000)
}
async function retainWorkerOutcome (outcome, adapter) {
  report.worker = outcome
  if (outcome.status === 'waiting') await retainNavigation(adapter)
}
const total = values => Object.values(values).reduce((a, b) => a + b, 0)
function noEffects (before, after) {
  assert.deepEqual(after.stock, before.stock)
  assert.deepEqual(after.operator_reserve, before.operator_reserve)
  assert.deepEqual(after.blocks, before.blocks)
  for (const name of ['WorldBuilder', 'WorldRequester', 'WorldInspector']) assert.deepEqual(after.players[name].items, before.players[name].items)
}
function structuralBlocks (blocks) {
  return Object.fromEntries(Object.entries(blocks).map(([key, raw]) => {
    const start = raw.indexOf('[')
    const properties = start < 0 ? {} : Object.fromEntries(raw.slice(start + 1, -1).split(',').map(pair => pair.split('=')))
    return [key, structural(start < 0 ? raw : raw.slice(0, start), properties)]
  }))
}
async function refuseUnsneakedThinReference (adapter, worker) {
  const actual = await adapter.observe(worker.placements)
  const placement = worker.placements.find(p => actual.blocks[p.key] !== p.state && ['repeater', 'redstone_wire'].includes(adapter.referenceFor(p)?.block.name))
  assert.ok(placement, 'Continuation must exercise the new thin-reference boundary.')
  await adapter.preparePlacement(placement)
  adapter.bot.setControlState('sneak', false)
  await bounded(adapter.bot.waitForTicks(1), 1500, 'UNSNEAK_FLUSH_TIMEOUT')
  const before = await observation()
  const revision = (await state()).revision
  const reference = adapter.referenceFor(placement)
  const eventsBefore = (await fs.readFile(path.join(runtime, 'construction-events.jsonl'), 'utf8')).trim().split('\n').length
  const command = await adapter.envelope('PLACE', { x: placement.position[0], y: placement.position[1], z: placement.position[2], state: placement.state })
  assert.equal((await adapter.request('/command', command)).status, 'PREPARED')
  let nativeMessage = 'acknowledged'
  try { await bounded(adapter.bot._placeBlockWithOptions(reference.block, reference.face, { swingArm: 'right' }), 6500, 'EXPECTED_DENIED_NATIVE_ACK_TIMEOUT') } catch (error) { nativeMessage = error.message }
  const replay = await adapter.replay(command)
  assert.equal(replay.status, 'REFUSED')
  assert.equal(replay.code, 'RECORDED_NOT_APPLIED')
  const returnedTick = (await observation()).tick
  const after = await poll(observation, value => value.tick > returnedTick, 'fresh unsneaked refusal observation')
  assert.deepEqual(structuralBlocks(after.blocks), structuralBlocks(before.blocks))
  assert.deepEqual(after.stock, before.stock)
  for (const name of ['WorldBuilder', 'WorldRequester', 'WorldInspector']) assert.deepEqual(after.players[name].items, before.players[name].items)
  assert.equal((await state()).revision, revision)
  const newEvents = (await fs.readFile(path.join(runtime, 'construction-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).slice(eventsBefore)
  const denied = newEvents.filter(event => event.event === 'native_interact' && event.position.join(',') === reference.block.position.toArray().join(',') && event.use_item === 'DENY' && event.use_block === 'DENY')
  assert.ok(denied.length > 0, 'Actual receiving boundary must deny the unsneaked reference interaction.')
  report.denied_thin_reference_events = denied
  check('unsneaked-thin-reference-refused-with-original-operation-reconciled', { target: placement.position, reference: reference.block.position.toArray(), reference_material: reference.block.name, native_message: nativeMessage, replay, revision })
}
async function post (deployment, actor, action, params = {}, changes = {}, session = sessions.get(actor)) {
  await delay(Math.max(0, 650 - (performance.now() - lastPost)))
  lastPost = performance.now()
  const command = { operationId: crypto.randomUUID(), serverId: deployment.serverId, jobId: deployment.jobId,
    agreementVersion: deployment.agreementVersion, actorId: offlineUuid(actor), expectedRevision: (await state()).revision,
    authorizationReference: deployment.authorizationReference, expiresAtMs: Date.now() + 8000, action, params, ...changes }
  const response = await fetch(`http://127.0.0.1:${process.env.AC_CONSTRUCTION_HTTP_PORT}/command`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'X-AgentCity-Session': session, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(15000)
  })
  return { http: response.status, body: await response.json() }
}
async function guards (adapter, plan) {
  const before = await observation()
  const revision = (await state()).revision
  const glass = plan.construction_access.positions.find(p => p[1] === 0)
  await assert.rejects(adapter.go(glass.map((n, i) => n + adapter.origin[i])), /NAVIGATION_BLOCKED/)
  noEffects(before, await observation())
  check('bounded-obstructed-navigation-preserves-stock-and-structure', { target_relative: glass })
  await adapter.openStock()
  try {
    const params = { item: 'minecraft:stone_bricks', count: 1 }
    const wrongSession = await post(plan.deployment, 'WorldBuilder', 'WITHDRAW', params, {}, 'invalid-fixture-session')
    assert.equal(wrongSession.http, 401)
    assert.equal(wrongSession.body.code, 'ACTOR_SESSION')
    const stale = await post(plan.deployment, 'WorldBuilder', 'WITHDRAW', params, { expectedRevision: revision + 1 })
    assert.equal(stale.body.status, 'REFUSED')
    assert.equal(stale.body.code, 'STALE_REVISION')
    const expired = await post(plan.deployment, 'WorldBuilder', 'WITHDRAW', params, { expiresAtMs: Date.now() - 1 })
    assert.equal(expired.body.status, 'REFUSED')
    assert.equal(expired.body.code, 'EXPIRED_OR_OVERLONG')
    const unauthorized = await post(plan.deployment, 'WorldRequester', 'INSPECT')
    assert.equal(unauthorized.body.status, 'REFUSED')
    assert.equal(unauthorized.body.code, 'FORBIDDEN')
    const locked = await post(plan.deployment, 'WorldInspector', 'LOCK')
    assert.equal(locked.body.status, 'APPLIED', JSON.stringify(locked))
    const denied = await post(plan.deployment, 'WorldBuilder', 'WITHDRAW', params)
    assert.equal(denied.body.status, 'REFUSED')
    assert.equal(denied.body.code, 'LOCKED')
    const unlocked = await post(plan.deployment, 'WorldInspector', 'UNLOCK')
    assert.equal(unlocked.body.status, 'APPLIED', JSON.stringify(unlocked))
    const loan = { item: 'minecraft:redstone', count: 1 }
    const withdrawn = await post(plan.deployment, 'WorldBuilder', 'WITHDRAW', loan)
    assert.equal(withdrawn.body.status, 'APPLIED', JSON.stringify(withdrawn))
    await adapter.waitInventory(loan.item, 1)
    await adapter.closeStock()
    const held = adapter.bot.inventory.items().find(item => item.name === 'redstone')
    assert.ok(held)
    await adapter.bot.equip(held, 'hand')
    const approvedWire = plan.blueprint.placements.find(p => p.block === 'minecraft:redstone_wire')
    const absoluteWire = approvedWire.position.map((n, i) => n + adapter.origin[i])
    const expiredPlacement = await post(plan.deployment, 'WorldBuilder', 'PLACE', {
      x: absoluteWire[0], y: absoluteWire[1], z: absoluteWire[2], state: 'minecraft:redstone_wire'
    }, { expiresAtMs: Date.now() - 1 })
    assert.equal(expiredPlacement.body.status, 'REFUSED')
    assert.equal(expiredPlacement.body.code, 'EXPIRED_OR_OVERLONG')
    await adapter.openStock()
    const returned = await post(plan.deployment, 'WorldBuilder', 'RETURN', loan)
    assert.equal(returned.body.status, 'APPLIED', JSON.stringify(returned))
    await adapter.waitInventory(loan.item, 0)
    const returnedTick = (await observation()).tick
    const afterReturn = await poll(observation, value => value.tick > returnedTick &&
      value.stock[loan.item] === before.stock[loan.item] && !(value.players.WorldBuilder.items[loan.item] > 0),
    'actual stock restored after expired-placement check', 5000)
    noEffects(before, afterReturn)
    const after = await state()
    assert.equal(after.revision, revision)
    assert.equal(after.quarantined, false)
    assert.equal(after.lockMode, 'NONE')
    assert.equal(after.pendingOperation ?? null, null)
    check('receiving-boundary-refuses-session-role-revision-expiry-and-lock-without-effects', { wrong_session: wrongSession.body.code, unauthorized_role: unauthorized.body.code, stale: stale.body.code, expired_withdrawal: expired.body.code, expired_placement: expiredPlacement.body.code, locked: denied.body.code })
  } finally { await adapter.closeStock() }
  await delay(650)
}
async function inspect (deployment, adapter) {
  await delay(Math.max(0, 650 - (performance.now() - adapter.lastCommand)))
  const current = await state()
  const command = { operationId: crypto.randomUUID(), serverId: deployment.serverId, jobId: deployment.jobId, agreementVersion: deployment.agreementVersion, actorId: offlineUuid('WorldInspector'), expectedRevision: current.revision, authorizationReference: deployment.authorizationReference, expiresAtMs: Date.now() + 8000, action: 'INSPECT', params: {} }
  const response = await fetch(`http://127.0.0.1:${process.env.AC_CONSTRUCTION_HTTP_PORT}/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'X-AgentCity-Session': sessions.get('WorldInspector'), 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  const accepted = await response.json()
  assert.equal(accepted.status, 'APPLIED', JSON.stringify(accepted))
  const directory = path.join(runtime, 'plugins/AgentCity/reports')
  const physical = await poll(async () => {
    let files
    try { files = await fs.readdir(directory) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    return files.length ? JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8')) : null
  }, Boolean, 'real16-case lamp inspection', 240000)
  report.inspection = physical
  assert.equal(physical.rows.length, 16)
  assert.equal(physical.status, 'PASS', 'Actual lamp inspection must pass; glass access is not assumed electrically neutral.')
  assert.ok(physical.rows.every(row => row.observed === row.expected))
  const ready = await poll(state, value => value.readyForReview, 'retained local protected readiness', 10000)
  assert.equal(ready.lockMode, 'REVIEW')
  check('real16-case-inspection-after-native-construction', { revision: physical.revision, rows: physical.rows.length, actual_correct: 16, report_id: physical.runId, readiness: ready.readyForReview })
}

async function proposed (action, deployment, execute, allowWait = false) {
  if (!internal) return execute()
  const { runLocalProposal } = await import(pathToFileURL(path.join(sourceRoot, 'backend/src/bot/proposal-gate.mjs')).href)
  const result = await runLocalProposal({ action, execute, observe: async () => {
    const current = await state()
    const scopedActor = action === 'construct' ? 'WorldBuilder' : 'WorldInspector'
    const expectedRole = action === 'construct' ? 'BOT' : 'INSPECTOR'
    const authorized = sessions.has(scopedActor) && deployment.actors[offlineUuid(scopedActor)] === expectedRole && !current.quarantined
    return { jobId: deployment.jobId, expectedRevision: current.revision, lockMode: current.lockMode,
      authorizedConstruction: action === 'construct' && authorized, authorizedInspection: action === 'inspect' && authorized }
  } })
  report.inference ??= []
  report.inference.push({ action, status: result.status, proposal: result.proposal, evidence: result.evidence })
  assert.equal(result.evidence.mode, 'ollama_local')
  assert.equal(result.evidence.failure, undefined)
  if (result.status === 'waiting' && allowWait) return result
  assert.equal(result.status, 'executed')
  assert.equal(result.proposal.action, action)
  return result.result
}

async function run () {
  const plan = JSON.parse(await fs.readFile(path.join(runtime, 'construction-fixture.json'), 'utf8'))
  assert.equal(plan.final_circuit_seeded, false)
  const builder = await connect('WorldBuilder')
  await connect('WorldRequester')
  await connect('WorldInspector')
  await poll(observation, value => Object.keys(value.players).length === 3, 'all scoped actors observed')
  const origin = plan.deployment.plotMin.map((n, i) => n + [4, 1, 4][i])
  const bounds = plan.construction_access.navigation_bounds_relative
  const adapter = new MinecraftAdapter({ bot: builder, deployment: plan.deployment, apiUrl: `http://127.0.0.1:${process.env.AC_CONSTRUCTION_HTTP_PORT}`, apiToken: token, session: sessions.get('WorldBuilder'), dependencyRoot, accessBounds: { min: bounds.min.map((n, i) => n + origin[i]), max: bounds.max.map((n, i) => n + origin[i]) }, constructionAccess: plan.construction_access })
  const workerOptions = { adapter, blueprint: plan.blueprint, blueprintSha256: plan.deployment.blueprintSha256, deployment: plan.deployment, checkpointPath: path.join(runtime, 'construction-checkpoint.json') }
  const worker = new ConstructionWorker(workerOptions)
  let lostReply
  if (internal && phase === 'initial') {
    const place = adapter.place.bind(adapter)
    let placed = 0
    adapter.place = async (placement, command) => {
      const reply = await place(placement, command)
      if (reply.status === 'APPLIED' || reply.status === 'REPLAY') placed++
      if (placed === 12) {
        lostReply = { operationId: command.operationId, target: placement.key, appliedReply: reply }
        throw new Error('INJECTED_PLACEMENT_REPLY_LOST')
      }
      return reply
    }
  }
  if (plan.scenario === 'blocked') {
    const before = await observation()
    const relative = plan.blocked_access_relative
    const goal = relative.map((n, i) => n + origin[i])
    assert.deepEqual(before.stock, plan.material_bill)
    assert.equal(total(before.stock), 144)
    assert.equal(before.blocks[goal.join(',')], 'minecraft:glass')
    const started = performance.now()
    let refusal
    try { await adapter.go(goal) } catch (error) {
      refusal = error
      report.blocked_goal_relative = relative
      await retainNavigation(adapter)
    }
    assert.ok(refusal, 'An occupied declared crossing goal cannot count as reached.')
    assert.match(refusal.message, /NAVIGATION_BLOCKED/)
    assert.ok(performance.now() - started < 23000, 'Blocked navigation must remain bounded, including observation retention.')
    noEffects(before, report.waiting_observation)
    const untouched = await state()
    assert.equal(untouched.revision, 0)
    assert.equal(untouched.readyForReview, false)
    check('blocked-declared-crossing-goal-preserves-stock-and-world', { goal_relative: relative, refusal: refusal.message, actual_stock: before.stock, placements: 0, revision: untouched.revision })
    report.status = 'pass'
    return
  }
  if (plan.scenario === 'access') {
    const before = await observation()
    assert.deepEqual(before.stock, plan.material_bill)
    assert.equal(total(before.stock), 144)
    const entry = plan.construction_access.stairs.start_relative
    const landings = plan.construction_access.stairs.landings_relative
    async function visit (relative) {
      const goal = relative.map((n, i) => n + origin[i])
      try { await adapter.go(goal) } catch (error) {
        report.failed_access_waypoint = relative
        await retainNavigation(adapter)
        throw error
      }
      const returnedTick = (await observation()).tick
      const actual = await poll(observation, value => value.tick > returnedTick &&
        value.players.WorldBuilder.position.every((n, i) => i === 1 ? Math.abs(n - goal[i]) < 0.01 : Math.floor(n) === goal[i]),
      'actual server position at fixed access waypoint ' + relative.join(','), 5000)
      noEffects(before, actual)
      assert.equal(actual.players.WorldBuilder.mode, 'SURVIVAL')
      check('fixed-access-waypoint-' + relative.join(','), { goal_relative: relative, actual_server_position: actual.players.WorldBuilder.position })
    }
    async function crossBothLanes (point) {
      const [west, east] = plan.construction_access.crossing_x_relative
      const [north, south] = plan.construction_access.lane_z_relative
      const level = point[1]
      const joins = level === 0
        ? [[point[0], level, south], [east, level, south]]
        : [[point[0], level, south + 1], [east, level, south + 1], [east, level, south]]
      for (const join of joins) await visit(join)
      for (const corner of [[east, level, north], [west, level, north], [west, level, south], [east, level, south]]) await visit(corner)
      for (const join of joins.slice(0, -1).reverse()) await visit(join)
      await visit(point)
      check('declared-west-east-lane-crossings-at-level-' + level, { feet_level_relative: level, crossings_relative: [west, east], lanes_relative: [north, south] })
    }
    for (const point of [entry, ...landings]) {
      await visit(point)
      await crossBothLanes(point)
    }
    for (const point of [...landings.slice(0, -1).reverse(), entry]) await visit(point)
    const untouched = await state()
    assert.equal(untouched.revision, 0)
    assert.equal(untouched.readyForReview, false)
    check('access-only-calibration-preserves-all144-stock-and-empty-circuit', { stock: before.stock, placements: 0, revision: untouched.revision })
    report.status = 'pass'
    return
  }
  if (plan.scenario !== 'build') {
    const before = await observation()
    const revision = (await state()).revision
    assert.deepEqual(before.stock, plan.material_bill)
    assert.deepEqual(before.operator_reserve, plan.withheld_stock)
    assert.equal(total(before.stock) + total(before.operator_reserve), 144)
    const outcome = await worker.run()
    await retainWorkerOutcome(outcome, adapter)
    assert.equal(outcome.status, 'waiting', JSON.stringify(outcome))
    assert.match(outcome.reason, plan.scenario === 'shortage' ? /^MATERIAL_SHORTAGE:minecraft:stone_bricks$/ : /^UNEXPECTED_BLOCK:/)
    assert.equal(outcome.placedThisRun, 0)
    assert.equal(outcome.readiness, false)
    const checkpoint = JSON.parse(await fs.readFile(path.join(runtime, 'construction-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.receipts.length, 0)
    assert.equal(checkpoint.pending, null)
    noEffects(before, await observation())
    assert.equal((await state()).revision, revision)
    assert.equal((await state()).readyForReview, false)
    check(plan.scenario === 'shortage' ? 'missing-required-stock-waits-without-withdrawal-or-creation' : 'occupied-target-waits-without-destruction-or-consumption', { reason: outcome.reason, actual_stock: before.stock, operator_reserve: before.operator_reserve, placed: 0, receipts: 0 })
    report.status = 'pass'
    return
  }
  if (phase === 'initial') {
    const before = await observation()
    assert.deepEqual(before.stock, plan.material_bill)
    for (const p of plan.blueprint.placements) {
      const key = p.position.map((n, i) => n + origin[i]).join(',')
      assert.equal(before.blocks[key] || 'minecraft:air', 'minecraft:air', 'No final circuit placement may be seeded.')
    }
    assert.equal((await state()).readyForReview, false)
    check('fresh-empty-circuit-and-exact-controlled-stock', { final_blocks_seeded: 0, stock_total: Object.values(before.stock).reduce((a, b) => a + b, 0), operator_glass: plan.construction_access.positions.length })
    assert.throws(() => new ConstructionWorker({ ...workerOptions, orientation: 'rotated' }), /UNSUPPORTED_ORIENTATION/)
    assert.throws(() => new ConstructionWorker({ ...workerOptions, blueprintSha256: '0'.repeat(64) }), /BLUEPRINT_HASH_MISMATCH/)
    noEffects(before, await observation())
    check('unsupported-orientation-and-blueprint-hash-refused-before-effects', { refused: 2 })
    await guards(adapter, plan)
    const outcome = await proposed('construct', plan.deployment, () => worker.run({ maxPlacements: 12 }))
    await retainWorkerOutcome(outcome, adapter)
    assert.equal(outcome.status, internal ? 'waiting' : 'checkpointed', JSON.stringify(outcome))
    assert.equal(outcome.completed, internal ? 11 : 12)
    if (internal) assert.equal(outcome.reason, 'INJECTED_PLACEMENT_REPLY_LOST')
    assert.equal(outcome.readiness, false)
    const after = await poll(observation, value => value.tick > before.tick &&
      Object.values(value.stock).reduce((a, b) => a + b, 0) + Object.values(value.players.WorldBuilder.items).reduce((a, b) => a + b, 0) === 132,
    'fresh initial-stage effects')
    const checkpoint = JSON.parse(await fs.readFile(path.join(runtime, 'construction-checkpoint.json'), 'utf8'))
    if (internal) {
      assert.equal(checkpoint.pending.command.operationId, lostReply.operationId)
      assert.equal(checkpoint.receipts.filter(receipt => receipt.action === 'PLACE').length, 11)
      report.interruption = lostReply
      check('real-native-placement-applied-before-lost-reply', { operationId: lostReply.operationId, acknowledgedPlacements: 11, physicalPlacements: 12, pendingRetained: true })
    } else assert.equal(checkpoint.pending, null)
    assert.equal(checkpoint.completed.length, internal ? 11 : 12)
    const totalCarried = Object.values(after.players.WorldBuilder.items).reduce((a, b) => a + b, 0)
    const totalStock = Object.values(after.stock).reduce((a, b) => a + b, 0)
    assert.equal(totalCarried + totalStock + 12, 144)
    assert.equal((await state()).readyForReview, false)
    await fs.writeFile(path.join(runtime, 'construction-initial.json'), JSON.stringify({ completed: 12, inventory: after.players.WorldBuilder.items, stock: after.stock, revision: (await state()).revision, ...(internal ? { lostReply } : {}) }) + '\n')
    check('native12-placement-checkpoint-and-stock-conservation', { completed: 12, carried: totalCarried, stock: totalStock, revision: checkpoint.stages.at(-1)?.revision || (await state()).revision })
  } else {
    const continuation = process.env.AC_CONSTRUCTION_CONTINUATION_BASELINE
    const prior = JSON.parse(await fs.readFile(continuation || path.join(runtime, 'construction-initial.json'), 'utf8'))
    const before = await observation()
    assert.deepEqual(before.players.WorldBuilder.items, prior.inventory)
    assert.deepEqual(before.stock, prior.stock)
    if (continuation) {
      assert.equal(prior.schema, 'agentcity.p2.continuation-baseline.v1')
      assert.equal(prior.jobId, plan.deployment.jobId)
      assert.deepEqual(structuralBlocks(before.blocks), structuralBlocks(prior.blocks))
      for (const input of plan.blueprint.inputs) {
        const key = input.position.map((n, i) => n + origin[i]).join(',')
        assert.equal(before.blocks[key], prior.blocks[key], 'Input lever settings must survive the restart exactly.')
      }
      for (const name of ['WorldBuilder', 'WorldRequester', 'WorldInspector']) assert.deepEqual(before.players[name].items, prior.players[name].items)
      assert.equal((await state()).revision, prior.revision)
      assert.equal((await state()).pendingOperation ?? null, null)
      assert.equal(total(before.players.WorldBuilder.items) + total(before.stock) + prior.completed, 144)
      report.continuation = { source_run: prior.source_run, prior_applied_placements: prior.completed, expected_new_placements: 144 - prior.completed, no_world_or_stock_restoration: true }
      check('same-world-restart-matches-retained-structure-and-all-real-inventories', { prior_applied_placements: prior.completed, carried: prior.inventory, stock: prior.stock, revision: prior.revision })
      if (prior.completed < 144) await refuseUnsneakedThinReference(adapter, worker)
    }
    check('new-process-reconnect-preserves-real-carried-stock', { carried: before.players.WorldBuilder.items, stock: before.stock, revision: (await state()).revision })
    const recovery = []
    if (internal) {
      const pending = JSON.parse(await fs.readFile(path.join(runtime, 'construction-checkpoint.json'), 'utf8')).pending
      assert.equal(pending.command.operationId, prior.lostReply.operationId)
      const replay = adapter.replay.bind(adapter)
      adapter.replay = async command => {
        const reply = await replay(command)
        if (command.operationId === prior.lostReply.operationId) {
          const recovered = { operationId: command.operationId, reply }
          recovery.push(recovered)
          report.recovery = recovered
          assert.equal(reply.status, 'REPLAY')
          check('original-pending-placement-receipt-reconciled', recovered)
        }
        return reply
      }
    }
    const outcome = await proposed('construct', plan.deployment, () => worker.run())
    await retainWorkerOutcome(outcome, adapter)
    assert.equal(outcome.status, 'built', JSON.stringify(outcome))
    assert.equal(outcome.completed, 144)
    assert.equal(outcome.placedThisRun, 144 - prior.completed)
    assert.equal(outcome.readiness, false)
    const checkpoint = JSON.parse(await fs.readFile(path.join(runtime, 'construction-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.pending, null)
    assert.equal(checkpoint.completed.length, 144)
    assert.equal(checkpoint.receipts.filter(receipt => receipt.action === 'PLACE').length, 144)
    if (internal) {
      assert.equal(recovery.length, 1)
      assert.equal(recovery[0].reply.status, 'REPLAY')
      assert.equal(checkpoint.receipts.filter(receipt => receipt.operationId === prior.lostReply.operationId).length, 1)
      report.recovery = recovery[0]
      check('uncertain-placement-replayed-once-without-new-effect', recovery[0])
    }
    const consumedThisSegment = {}
    for (const receipt of checkpoint.receipts.filter(receipt => receipt.action === 'PLACE').slice(prior.completed)) consumedThisSegment[receipt.item] = (consumedThisSegment[receipt.item] || 0) + receipt.count
    assert.deepEqual(consumedThisSegment, prior.inventory)
    report.consumed_this_segment_by_material = consumedThisSegment
    const completed = await poll(observation, value => Object.keys(value.stock).length === 0 && Object.keys(value.players.WorldBuilder.items).length === 0, 'final stock/inventory effect')
    for (const p of plan.blueprint.placements) {
      const key = p.position.map((n, i) => n + origin[i]).join(',')
      const observed = completed.blocks[key]
      const start = observed.indexOf('[')
      const properties = start < 0 ? {} : Object.fromEntries(observed.slice(start + 1, -1).split(',').map(pair => pair.split('=')))
      assert.equal(structural(start < 0 ? observed : observed.slice(0, start), properties), worker.placements.find(value => value.key === key).state)
    }
    const events = (await fs.readFile(path.join(runtime, 'construction-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const placements = events.filter(event => event.event === 'native_place' && !event.cancelled)
    assert.equal(placements.length, 144)
    assert.equal(new Set(placements.map(event => event.position.join(','))).size, 144)
    assert.equal((await state()).readyForReview, false)
    check('complete-native-build-consumes-exact144-items-once', { native_placements: placements.length, actual_empty_stock: true, actual_empty_builder_inventory: true, stage_count: checkpoint.stages.length, readiness: false })
    await proposed('inspect', plan.deployment, () => inspect(plan.deployment, adapter))
    if (internal) {
      const revision = (await state()).revision
      assert.ok(report.inspection && report.inspection.status === 'PASS')
      assert.equal((await state()).lockMode, 'REVIEW')
      const wait = await proposed('construct', plan.deployment, () => { throw new Error('LOCKED_ACTION_MUST_NOT_EXECUTE') }, true)
      assert.equal(wait.status, 'waiting')
      assert.equal(wait.proposal.action, 'wait')
      assert.equal((await state()).revision, revision)
      check('real-ollama-respects-protected-review', { action: wait.proposal.action, revision })
      report.economic_bridge = false
      report.inference_model = 'qwen3:1.7b'
    }
  }
  report.status = 'pass'
}

run().catch(error => { report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  closing = true
  for (const bot of clients) { try { bot.pathfinder?.stop(); bot.clearControlStates(); bot.quit('Local construction fixture complete') } catch { bot.end() } }
  await delay(500)
  report.finished_at = new Date().toISOString()
  const safe = clean(report)
  await fs.writeFile(process.env.AC_CONSTRUCTION_REPORT, JSON.stringify(safe, null, 2) + '\n')
  console.log(JSON.stringify({ status: safe.status, checks: safe.checks.length, error: safe.error }))
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref()
})
