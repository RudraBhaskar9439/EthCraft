'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const mineflayer = require('../compatibility/node_modules/mineflayer')
const { pathfinder, Movements, goals } = require('../compatibility/node_modules/mineflayer-pathfinder')

const runtime = process.env.AC_BOUNDARY_RUNTIME
const apiToken = process.env.AC_BOUNDARY_TOKEN
const gamePort = Number(process.env.AC_BOUNDARY_GAME_PORT || 25581)
const httpPort = Number(process.env.AC_BOUNDARY_HTTP_PORT || 25578)
const phase = process.env.AC_BOUNDARY_PHASE || 'initial'
const suite = process.env.AC_BOUNDARY_SUITE || 'primitives'
const clients = []
const movementTelemetry = new Map()
const sessions = new Map()
const secrets = new Set(apiToken ? [apiToken] : [])
const controller = new AbortController()
let closing = false
let lastCommand = 0
let plan
const report = {
  schema: 'agentcity.p1.boundary-client.v1', status: 'fail', phase, suite,
  started_at: new Date().toISOString(), full_phase_gate_passed: false,
  identities: 'All four clients are agent-controlled offline fixtures. No independent-human, licensed-account or production authentication claim.',
  steps: []
}

function clean (value) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('<redacted-credential>')
    return value.replace(/AC_SESSION\s+[0-9a-f-]{36}\s+\S+/gi, 'AC_SESSION <redacted>')
  }
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]))
  return value
}

function stop (error) {
  if (!closing && !controller.signal.aborted) controller.abort(error)
}

async function bounded (operation, label, timeout = 6000) {
  if (controller.signal.aborted) throw controller.signal.reason
  let timer
  let onAbort
  try {
    return await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout after ${timeout} ms`)), timeout)
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

const delay = ms => bounded(new Promise(resolve => setTimeout(resolve, ms)), 'probe spacing', ms + 2000)

async function poll (read, predicate, label, timeout = 6000) {
  const deadline = performance.now() + timeout
  let value
  while (performance.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await delay(250)
  }
  throw new Error(`${label}: condition not met: ${JSON.stringify(clean(value))}`)
}

function offlineUuid (name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  bytes[6] = (bytes[6] & 15) | 48
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function connect (username) {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: gamePort, username, version: '1.21.11', auth: 'offline' })
  clients.push(bot)
  const movement = { received_teleports: [], sent_teleport_confirmations: [], sent_positions: [], position_packet_count: 0, packet_counts: {} }
  movementTelemetry.set(username, movement)
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, data, ...rest) => {
    if (['position', 'position_look', 'teleport_confirm', 'player_loaded', 'client_tick_end', 'tick_end', 'flying'].includes(name)) movement.packet_counts[name] = (movement.packet_counts[name] || 0) + 1
    if (name === 'teleport_confirm') movement.sent_teleport_confirmations.push({ teleport_id: data.teleportId, at_ms: Date.now() })
    if (['position', 'position_look'].includes(name)) {
      movement.position_packet_count++
      movement.sent_positions.push({ x: data.x, y: data.y, z: data.z, at_ms: Date.now() })
      if (movement.sent_positions.length > 10) movement.sent_positions.shift()
    }
    return write(name, data, ...rest)
  }
  bot._client.on('position', packet => movement.received_teleports.push({ x: packet.x, y: packet.y, z: packet.z, teleport_id: packet.teleportId, at_ms: Date.now() }))
  bot.on('messagestr', message => {
    if (!message.startsWith('AC_SESSION ')) return
    const parts = message.trim().split(/\s+/)
    if (parts.length === 3 && parts[1] === offlineUuid(username)) {
      sessions.set(username, parts[2])
      secrets.add(parts[2])
    }
  })
  bot.on('error', error => stop(new Error(`${username}: ${error.message}`)))
  bot.on('kicked', reason => stop(new Error(`${username}: kicked: ${String(reason)}`)))
  bot.on('end', reason => stop(new Error(`${username}: disconnected: ${String(reason)}`)))
  await bounded(new Promise(resolve => bot.once('spawn', resolve)), `${username} spawn`, 15000)
  await bounded(bot.waitForChunksToLoad(), `${username} chunk observations`, 10000)
  if (username !== 'WorldStranger') await poll(async () => sessions.get(username), Boolean, `${username} session`, 5000)
  bot.loadPlugin(pathfinder)
  const moves = new Movements(bot)
  moves.canDig = false
  moves.allow1by1towers = false
  moves.allowParkour = false
  moves.maxDropDown = 0
  moves.scafoldingBlocks = []
  moves.exclusionAreasBreak.push(() => 100)
  moves.exclusionAreasPlace.push(() => 100)
  moves.exclusionAreasStep.push(block => block.position.x < -18 || block.position.x > 17 || block.position.z < -10 || block.position.z > 9 || block.position.y < 80 || block.position.y > 83 ? 100 : 0)
  bot.pathfinder.setMovements(moves)
  return bot
}

async function http (route, options = {}) {
  const headers = { Authorization: `Bearer ${options.token === undefined ? apiToken : options.token}` }
  if (options.actor) headers['X-AgentCity-Session'] = options.session === undefined ? sessions.get(options.actor) || '' : options.session
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await bounded(fetch(`http://127.0.0.1:${httpPort}${route}`, {
    method: options.body === undefined ? 'GET' : 'POST', headers,
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000)
  }), 'local control response', 16000)
  return { http_status: response.status, body: await response.json() }
}

async function state () {
  const response = await http('/status')
  assert.equal(response.http_status, 200, 'durable state must be available')
  assert.ok(response.body.state)
  return response.body
}

async function observation () {
  return JSON.parse(await fs.readFile(path.join(runtime, 'boundary-observation.json'), 'utf8'))
}

function structural (raw) {
  const start = raw.indexOf('[')
  if (start < 0) return raw
  const material = raw.slice(0, start)
  const dynamic = new Set(['lit', 'powered', 'power', 'locked'])
  if (material === 'minecraft:redstone_wire') for (const direction of ['east', 'west', 'north', 'south']) dynamic.add(direction)
  const fields = raw.slice(start + 1, -1).split(',').filter(pair => !dynamic.has(pair.split('=')[0])).sort()
  return material + (fields.length ? `[${fields.join(',')}]` : '')
}

async function capture () {
  const [world, control] = await Promise.all([observation(), state()])
  const blocks = Object.fromEntries(Object.entries(world.blocks).map(([k, v]) => [k, structural(v)]))
  return {
    state: control.state, refusals: control.refusals, tick: world.tick, observed_at_ms: world.observed_at_ms,
    target: world.blocks[plan.placement_target.join(',')], stock: world.stock,
    players: world.players, structural_sha256: crypto.createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  }
}

function noEffects (before, after, label) {
  assert.equal(after.structural_sha256, before.structural_sha256, `${label}: structure unchanged`)
  assert.deepEqual(after.stock, before.stock, `${label}: job stock unchanged`)
  for (const name of ['WorldBuilder', 'WorldRequester', 'WorldStranger']) assert.deepEqual(after.players[name].items, before.players[name].items, `${label}: ${name} inventory unchanged`)
  for (const key of ['revision', 'lockMode', 'quarantined', 'readyForReview', 'passValidUntilMs']) assert.equal(after.state[key], before.state[key], `${label}: ${key} unchanged`)
}

function step (name, details) {
  report.steps.push({ name, status: 'pass', at: new Date().toISOString(), ...details })
  console.log(JSON.stringify({ step: name, status: 'pass' }))
}

async function envelope (actor, action, params = {}, changes = {}) {
  const current = (await state()).state
  const d = plan.deployment
  return { operationId: crypto.randomUUID(), serverId: d.serverId, jobId: d.jobId,
    agreementVersion: d.agreementVersion, actorId: offlineUuid(actor), expectedRevision: current.revision,
    authorizationReference: d.authorizationReference, expiresAtMs: Date.now() + 8000, action, params, ...changes }
}

async function command (actor, body, options = {}) {
  if (options.throttle !== false) await delay(Math.max(0, 650 - (performance.now() - lastCommand)))
  lastCommand = performance.now()
  return http('/command', { actor, body, ...options })
}

function refused (response, label) {
  assert.ok(response.http_status >= 400 || response.body.status === 'REFUSED', `${label}: typed refusal: ${JSON.stringify(response.body)}`)
  assert.notEqual(response.body.status, 'RECONCILIATION_REQUIRED', `${label}: refusal must not create an unknown-effect incident`)
}

async function refusalCheck (name, actor, payload, options) {
  const before = await capture()
  const response = await command(actor, payload, options)
  refused(response, name)
  await delay(300)
  const after = await capture()
  noEffects(before, after, name)
  step(name, { payload, response, before, after })
  return response
}

function block (bot, xyz) {
  const position = bot.entity.position.offset(xyz[0] - bot.entity.position.x, xyz[1] - bot.entity.position.y, xyz[2] - bot.entity.position.z)
  const value = bot.blockAt(position)
  assert.ok(value, `real client block unavailable at ${xyz}`)
  return value
}

async function go (bot, x, z) {
  const started = Date.now()
  const before = (await observation()).players[bot.username].position
  await bounded(bot.pathfinder.goto(new goals.GoalBlock(x, 81, z)), `${bot.username} bounded navigation`, 18000)
  const diagnostic = { name: bot.username, goal: [x, 81, z], before, client_position: bot.entity.position.clone(), client_mode: bot.game.gameMode, physics_enabled: bot.physicsEnabled, alive: bot.isAlive, telemetry: movementTelemetry.get(bot.username) }
  report.last_navigation = diagnostic
  const authoritative = await poll(observation, value => value.observed_at_ms >= started && Math.floor(value.players[bot.username].position[0]) === x && Math.floor(value.players[bot.username].position[2]) === z && Math.abs(value.players[bot.username].position[1] - 81) < 0.1, `${bot.username} server-confirmed navigation`, 5000)
  step('server_confirmed_navigation', { ...diagnostic, server_position: authoritative.players[bot.username].position, observed_at_ms: authoritative.observed_at_ms })
}

async function equip (bot, name) {
  const item = bot.inventory.items().find(item => item.name === name)
  assert.ok(item, `${bot.username} must hold actual ${name}`)
  await bounded(bot.equip(item, 'hand'), `${bot.username} equip ${name}`)
}

async function chest (bot) {
  await go(bot, -14, 3)
  return bounded(bot.openContainer(block(bot, [-14, 81, 5])), 'open protected stock', 5000)
}

async function waitSettled (revision, timeout = 7000) {
  return poll(state, value => !value.state.pendingOperation && value.state.revision === revision && !value.state.quarantined, 'durable operation completion', timeout)
}

async function nativeEvents () {
  try { return (await fs.readFile(path.join(runtime, 'boundary-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function nativeDenied (name, bot, action, expectedPositions) {
  const before = await capture()
  const eventCount = (await nativeEvents()).length
  let outcome = 'native call acknowledged but refused by authoritative state'
  try { await bounded(action(), name, 4500) } catch (error) { outcome = error.message }
  await delay(600)
  const after = await capture()
  noEffects(before, after, name)
  const events = await poll(async () => (await nativeEvents()).slice(eventCount), rows => rows.some(row => row.actor === offlineUuid(bot.username) && (row.cancelled === true || row.use_block === 'DENY') && expectedPositions.some(position => JSON.stringify(row.position) === JSON.stringify(position))), `${name} real denied event`, 3000)
  step(name, { native_client_outcome: outcome, denied_event_evidence: events, before, after })
}

async function stockTransfer (bot, action, count = 1) {
  const open = await chest(bot)
  try {
    const before = await observation()
    const payload = await envelope(bot.username, action, { item: 'minecraft:redstone', count })
    const response = await command(bot.username, payload)
    assert.equal(response.body.status, 'APPLIED', `${action} must complete a durable real transfer: ${JSON.stringify(response)}`)
    const direction = action === 'WITHDRAW' ? -1 : 1
    await poll(observation, value => value.stock['minecraft:redstone'] === before.stock['minecraft:redstone'] + direction * count && (value.players[bot.username].items['minecraft:redstone'] || 0) === (before.players[bot.username].items['minecraft:redstone'] || 0) - direction * count, `${action} real inventory observation`)
    return { payload, response }
  } finally { open.close() }
}

async function initial (bots) {
  const builder = bots.WorldBuilder
  const requester = bots.WorldRequester
  const stranger = bots.WorldStranger
  let before = await capture()
  assert.equal(before.state.revision, 0)
  assert.equal(before.state.lockMode, 'NONE')
  assert.equal(before.state.quarantined, false)
  assert.equal(before.target, 'minecraft:air')
  assert.deepEqual(before.stock, plan.stock)
  assert.equal(before.players.WorldBuilder.mode, 'SURVIVAL')
  assert.deepEqual(before.players.WorldBuilder.items, {})
  assert.equal(before.players.WorldStranger.display_name, 'WorldBuilder')
  assert.notEqual(before.players.WorldStranger.uuid, before.players.WorldBuilder.uuid)
  step('physical_fixture_baseline', { before })
  const unauthorized = await http('/status', { token: 'invalid' })
  assert.equal(unauthorized.http_status, 401)
  step('missing_control_authority_refused', { response: unauthorized })

  const placeParams = { x: -2, y: 82, z: -4, state: plan.placement_state }
  const valid = await envelope('WorldBuilder', 'PLACE', placeParams)
  await refusalCheck('wrong_live_actor_session', 'WorldBuilder', valid, { session: 'not-a-live-session' })
  for (const [name, edit] of [
    ['missing_parameters', value => { delete value.params }],
    ['null_actor', value => { value.actorId = null }],
    ['extra_envelope_field', value => { value.untrusted = true }]
  ]) {
    const payload = structuredClone(valid); edit(payload)
    await refusalCheck(name, 'WorldBuilder', payload)
  }
  for (const [field, value] of [['serverId', 'other-server'], ['jobId', 'other-job'], ['agreementVersion', 2], ['authorizationReference', 'other-authorization']]) {
    await refusalCheck(`cross_context_${field}`, 'WorldBuilder', await envelope('WorldBuilder', 'PLACE', placeParams, { [field]: value }))
  }
  await refusalCheck('requester_cannot_build', 'WorldRequester', await envelope('WorldRequester', 'PLACE', placeParams))
  await refusalCheck('requester_cannot_lock', 'WorldRequester', await envelope('WorldRequester', 'LOCK'))
  await refusalCheck('out_of_bounds_placement', 'WorldBuilder', await envelope('WorldBuilder', 'PLACE', { x: -17, y: 81, z: -7, state: 'minecraft:stone_bricks' }))

  await equip(stranger, 'cobblestone')
  await go(stranger, 12, -4)
  await nativeDenied('forged_display_name_cannot_place', stranger, () => stranger.placeBlock(block(stranger, [12, 80, -2]), stranger.entity.position.offset(0, 1, 0).minus(stranger.entity.position)), [[12, 80, -2], [12, 81, -2]])

  before = await capture()
  const withdrawn = await stockTransfer(builder, 'WITHDRAW')
  let after = await capture()
  assert.equal(after.stock['minecraft:redstone'], before.stock['minecraft:redstone'] - 1)
  assert.equal(after.players.WorldBuilder.items['minecraft:redstone'], 1)
  step('actual_job_stock_withdraw_once', { ...withdrawn, before, after })
  const withdrawReplay = await command('WorldBuilder', withdrawn.payload)
  assert.equal(withdrawReplay.body.status, 'REPLAY')
  noEffects(after, await capture(), 'withdraw replay')
  step('withdraw_replay_after_window_closed', { response: withdrawReplay })
  const returned = await stockTransfer(builder, 'RETURN')
  after = await capture()
  assert.deepEqual(after.stock, plan.stock)
  assert.deepEqual(after.players.WorldBuilder.items, {})
  step('actual_job_stock_return_once', { ...returned, after })
  const returnReplay = await command('WorldBuilder', returned.payload)
  assert.equal(returnReplay.body.status, 'REPLAY')
  noEffects(after, await capture(), 'return replay')
  step('return_replay_after_window_closed', { response: returnReplay })
  const open = await chest(builder)
  try {
    await refusalCheck('actual_stock_shortage_refused', 'WorldBuilder', await envelope('WorldBuilder', 'WITHDRAW', { item: 'minecraft:redstone', count: 20 }))
    await refusalCheck('forged_client_stock_field_refused', 'WorldBuilder', await envelope('WorldBuilder', 'WITHDRAW', { item: 'minecraft:redstone', count: 1, claimedStock: 1000 }))
  } finally { open.close() }
  await stockTransfer(builder, 'WITHDRAW')
  await equip(builder, 'redstone')
  await go(builder, -2, -7)
  await refusalCheck('stale_revision_refused', 'WorldBuilder', await envelope('WorldBuilder', 'PLACE', placeParams, { expectedRevision: 7 }))
  await refusalCheck('expired_command_refused', 'WorldBuilder', await envelope('WorldBuilder', 'PLACE', placeParams, { expiresAtMs: Date.now() - 1000 }))

  await fs.writeFile(path.join(runtime, 'boundary-mode-step'), 'creative_begin\n')
  await poll(observation, value => value.players.WorldBuilder.mode === 'CREATIVE', 'sealed Creative fault applied')
  before = await capture()
  const creative = await envelope('WorldBuilder', 'PLACE', placeParams)
  const creativeResponse = await command('WorldBuilder', creative)
  if (creativeResponse.body.status === 'PREPARED') {
    await nativeDenied('creative_native_placement_prevented', builder, () => builder.placeBlock(block(builder, plan.placement_support), builder.entity.position.offset(0, 1, 0).minus(builder.entity.position)), [plan.placement_support, plan.placement_target])
    await waitSettled(0, 12000)
  } else refused(creativeResponse, 'creative placement')
  await delay(350)
  after = await capture()
  noEffects(before, after, 'creative placement')
  step('creative_placement_refused_before_mutation', { payload: creative, response: creativeResponse, before, after })
  await fs.writeFile(path.join(runtime, 'boundary-mode-step'), 'creative_end\n')
  await poll(observation, value => value.players.WorldBuilder.mode === 'SURVIVAL', 'Survival restored')
  await fs.unlink(path.join(runtime, 'boundary-mode-step'))

  before = await capture()
  const placement = await envelope('WorldBuilder', 'PLACE', placeParams)
  const prepared = await command('WorldBuilder', placement)
  assert.equal(prepared.body.status, 'PREPARED', `valid native operation must arm: ${JSON.stringify(prepared)}`)
  await bounded(builder.placeBlock(block(builder, plan.placement_support), builder.entity.position.offset(0, 1, 0).minus(builder.entity.position)), 'actual survival redstone placement', 7000)
  await waitSettled(1)
  await delay(350)
  after = await capture()
  assert.equal(structural(after.target), 'minecraft:redstone_wire')
  assert.equal(after.players.WorldBuilder.items['minecraft:redstone'] || 0, 0)
  assert.deepEqual(after.stock, before.stock, 'placement consumes the carried job item, not an extra chest item')
  step('actual_survival_placement_consumes_once', { payload: placement, prepared, before, after })
  const replay = await command('WorldBuilder', placement)
  assert.equal(replay.body.status, 'REPLAY')
  assert.equal(replay.body.revision, 1)
  noEffects(after, await capture(), 'serial placement replay')
  step('placement_serial_replay_returns_original_receipt', { response: replay })
  await delay(1100)
  const concurrent = await Promise.all([command('WorldBuilder', placement, { throttle: false }), command('WorldBuilder', placement, { throttle: false })])
  assert.ok(concurrent.every(value => value.body.status === 'REPLAY'), JSON.stringify(concurrent))
  noEffects(after, await capture(), 'concurrent placement replay')
  step('placement_concurrent_replay_returns_original_receipt', { responses: concurrent })
  await delay(1100)
  const collision = structuredClone(placement); collision.params.x++
  const collisionResult = await refusalCheck('operation_id_parameter_collision', 'WorldBuilder', collision)
  assert.equal(collisionResult.body.code, 'OPERATION_ID_COLLISION')
  await nativeDenied('unarmed_native_break_prevented', builder, () => builder.dig(block(builder, plan.placement_target)), [plan.placement_target])

  const lockPayload = await envelope('WorldInspector', 'LOCK')
  const locked = await command('WorldInspector', lockPayload)
  assert.equal(locked.body.status, 'APPLIED')
  assert.equal((await state()).state.lockMode, 'INSPECTION')
  step('durable_inspection_lock_acquired', { payload: lockPayload, response: locked })
  await refusalCheck('locked_structure_break_refused', 'WorldBuilder', await envelope('WorldBuilder', 'BREAK', { x: -2, y: 82, z: -4 }))
  await go(requester, -8, -7)
  await nativeDenied('external_input_denied_by_inspection_lock', requester, () => requester.activateBlock(block(requester, [-8, 82, -3])), [[-8, 82, -3]])
  const unlockPayload = await envelope('WorldInspector', 'UNLOCK')
  const unlocked = await command('WorldInspector', unlockPayload)
  assert.equal(unlocked.body.status, 'APPLIED')
  assert.equal((await state()).state.lockMode, 'NONE')
  step('unused_inspection_lock_released_without_pass', { payload: unlockPayload, response: unlocked })
  await fs.writeFile(path.join(runtime, 'boundary-probe-state.json'), JSON.stringify({ placement, expected: await capture(), initial_assertion_groups: report.steps.length }, null, 2) + '\n')
}

async function inspection (bots) {
  const payload = await envelope('WorldInspector', 'INSPECT')
  const response = await command('WorldInspector', payload)
  assert.equal(response.body.status, 'APPLIED', `inspection should start: ${JSON.stringify(response)}`)
  step('real_checker_started', { payload, response })
  await delay(500)
  await refusalCheck('active_checker_cannot_unlock', 'WorldInspector', await envelope('WorldInspector', 'UNLOCK'))
  await refusalCheck('active_checker_structure_edit_denied', 'WorldBuilder', await envelope('WorldBuilder', 'BREAK', { x: -2, y: 82, z: -4 }))
  await go(bots.WorldRequester, -8, -7)
  // The checker owns the value, so use server cancellation evidence rather than guessing its concurrent input state.
  const beforeCount = (await state()).refusals.filter(value => value === 'interaction_not_authorized').length
  await bounded(bots.WorldRequester.activateBlock(block(bots.WorldRequester, [-8, 82, -3])), 'external checker input attempt').catch(() => {})
  await poll(state, value => value.refusals.filter(reason => reason === 'interaction_not_authorized').length > beforeCount, 'actual external input event denied')
  step('active_checker_external_input_event_denied', {})
  const review = await poll(state, value => value.state.lockMode === 'REVIEW' && value.state.readyForReview, 'real 16-case passing inspection', 200000)
  const directory = path.join(runtime, 'plugins/AgentCity/reports')
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json'))
  const reports = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))))
  const passed = reports.find(value => value.status === 'PASS' && value.rows.length === 16)
  assert.ok(passed, 'full actual checker report must remain retrievable')
  assert.ok(passed.rows.every(row => row.observed === row.a + row.b))
  assert.equal(new Set(passed.rows.map(row => `${row.a},${row.b}`)).size, 16)
  step('real_checker_full_report_ready', { state: review.state, report: passed })

  const requester = bots.WorldRequester
  const revision = review.state.revision
  for (const port of plan.blueprint.inputs) {
    const xyz = [-12 + port.position[0], 81 + port.position[1], -4 + port.position[2]]
    await go(requester, xyz[0], -7)
    const before = Boolean(block(requester, xyz).getProperties().powered)
    await delay(550)
    await bounded(requester.activateBlock(block(requester, xyz)), `review ${port.name} toggle`)
    await poll(async () => Boolean(block(requester, xyz).getProperties().powered), value => value !== before, `review ${port.name} real power change`)
    const current = (await state()).state
    assert.equal(current.revision, revision)
    assert.equal(current.lockMode, 'REVIEW')
    assert.equal(current.readyForReview, true)
    step(`approved_review_toggle_${port.name}`, { position: xyz, before, after: !before, state: current })
  }
  await go(requester, -8, -7)
  for (const bucket of ['water_bucket', 'lava_bucket']) {
    await equip(requester, bucket)
    requester.setControlState('sneak', true)
    try { await nativeDenied(`review_sneaking_${bucket}_prevented`, requester, () => requester.activateBlock(block(requester, [-8, 82, -3])), [[-8, 82, -3]]) } finally { requester.setControlState('sneak', false) }
  }
  await refusalCheck('usable_review_pass_cannot_unlock_early', 'WorldInspector', await envelope('WorldInspector', 'UNLOCK'))
  if (suite === 'lifecycle') {
    const expired = await poll(state, value => !value.state.readyForReview, 'local pass expiry', 35000)
    const unlock = await command('WorldInspector', await envelope('WorldInspector', 'UNLOCK'))
    assert.equal(unlock.body.status, 'APPLIED')
    step('expired_local_pass_unlock_without_external_obligation', { expired: expired.state, response: unlock })
  }
}

async function run () {
  assert.equal(gamePort, 25581)
  assert.equal(httpPort, 25578)
  assert.ok(runtime && apiToken && apiToken.length >= 32)
  assert.ok(['initial', 'restart'].includes(phase))
  plan = JSON.parse(await fs.readFile(path.join(runtime, 'boundary-fixture.json'), 'utf8'))
  assert.equal(plan.purpose, 'isolated_non_token_p1_boundary')
  const bots = {}
  for (const name of ['WorldBuilder', 'WorldRequester', 'WorldInspector', 'WorldStranger']) {
    bots[name] = await connect(name)
    await delay(4200)
  }
  await poll(observation, value => Object.keys(value.players).length === 4, 'four actual live fixture clients')
  await poll(state, value => !value.state.quarantined && !value.state.pendingOperation, 'world/inventory recovery checkpoint', 10000)
  if (phase === 'initial') await initial(bots)
  else {
    const retained = JSON.parse(await fs.readFile(path.join(runtime, 'boundary-probe-state.json'), 'utf8'))
    const before = await capture()
    noEffects(retained.expected, before, 'restart recovery')
    const replay = await command('WorldBuilder', retained.placement)
    assert.equal(replay.body.status, 'REPLAY', JSON.stringify(replay))
    assert.equal(replay.body.revision, 1)
    noEffects(before, await capture(), 'restart identical retry')
    step('restart_retry_returns_durable_original_receipt', { payload: retained.placement, response: replay, before, after: await capture() })
  }
  if (suite !== 'primitives' && phase === 'restart') await inspection(bots)
  report.status = 'pass'
}

if (process.argv.includes('--self-check')) {
  assert.equal(structural('minecraft:redstone_wire[east=side,power=15,north=none,south=none,west=side]'), 'minecraft:redstone_wire')
  assert.equal(structural('minecraft:lever[face=wall,facing=east,powered=true]'), 'minecraft:lever[face=wall,facing=east]')
  assert.equal(offlineUuid('WorldBuilder').length, 36)
  secrets.add('credential-test')
  assert.equal(clean('credential-test'), '<redacted-credential>')
  console.log('PASS: structural projection, fixture UUID and credential sanitization')
} else {
  const overall = setTimeout(() => stop(new Error('Boundary subset overall timeout')), suite === 'primitives' ? 170000 : 350000)
  run().catch(async error => {
    report.error = { name: error.name, message: error.message, stack: error.stack }
    try { report.final_observation = await capture() } catch (captureError) { report.final_observation_error = captureError.message }
    report.movement_telemetry = Object.fromEntries(movementTelemetry)
    process.exitCode = 1
  }).finally(async () => {
    closing = true
    clearTimeout(overall)
    for (const bot of clients) {
      try { bot.pathfinder?.stop(); bot.clearControlStates(); bot.quit('AgentCity boundary fixture finished') } catch { bot.end() }
    }
    report.finished_at = new Date().toISOString()
    const safe = clean(report)
    if (process.env.AC_BOUNDARY_REPORT) await fs.writeFile(path.resolve(process.env.AC_BOUNDARY_REPORT), JSON.stringify(safe, null, 2) + '\n')
    console.log(JSON.stringify({ status: safe.status, assertion_groups: safe.steps.length, error: safe.error }))
    setTimeout(() => process.exit(process.exitCode || 0), 1000).unref()
  })
}
