'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathfinder, Movements, goals } = require(path.join(process.env.AC_FAULT_MODULE_ROOT, 'mineflayer-pathfinder'))
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const target = [-2, 82, -4]
const support = [-2, 81, -4]
const stages = {
  'crash-before-intent': 'before_durable_intent',
  'crash-after-intent': 'after_intent_before_native',
  'crash-after-native-before-receipt': 'after_native_effect_before_receipt',
  'crash-after-applied-before-ack': 'after_durable_applied_before_workflow_ack',
  'partial-inventory-before-world-save': 'inventory_saved_world_save_not_run'
}

module.exports = async function recovery (c) {
  const { runtime, plan, phase, bots, report, poll, observed, state, http, step, delay, expectingCrash } = c
  const builder = bots.WorldBuilder
  const scenario = plan.fault_scenario
  assert.ok(stages[scenario])
  const readOptional = async name => fs.readFile(path.join(runtime, name), 'utf8').then(JSON.parse).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  const redstone = world => world.players.WorldBuilder.items['minecraft:redstone'] || 0
  const material = world => world.target_actual.split('[')[0]
  const at = (bot, xyz) => {
    const block = bot.blockAt(bot.entity.position.offset(xyz[0] - bot.entity.position.x, xyz[1] - bot.entity.position.y, xyz[2] - bot.entity.position.z))
    assert.ok(block, `actual client block required: ${xyz}`)
    return block
  }
  async function envelope (action, params) {
    const current = await state()
    return { operationId: crypto.randomUUID(), serverId: plan.deployment.serverId, jobId: plan.deployment.jobId, agreementVersion: plan.deployment.agreementVersion, actorId: builder.player.uuid, expectedRevision: current.state.revision, authorizationReference: plan.deployment.authorizationReference, expiresAtMs: Date.now() + 9000, action, params }
  }
  async function navigate (x, z) {
    const started = Date.now()
    await Promise.race([builder.pathfinder.goto(new goals.GoalBlock(x, 81, z)), delay(20000).then(() => { throw new Error('bounded fixed recovery route timed out') })])
    const actual = await poll(observed, value => value.at_ms >= started && Math.floor(value.players.WorldBuilder.position[0]) === x && Math.floor(value.players.WorldBuilder.position[2]) === z && Math.abs(value.players.WorldBuilder.position[1] - 81) < 0.1, 'authoritative fixed route arrival')
    step('server_confirmed_recovery_route', { goal: [x, 81, z], server_position: actual.players.WorldBuilder.position, client_position: builder.entity.position })
  }
  if (phase === 'restart') {
    const retained = JSON.parse(await fs.readFile(path.join(runtime, 'recovery-probe-state.json'), 'utf8'))
    const bytes = await fs.readFile(path.join(runtime, 'recovery-operation.json'))
    assert.equal(digest(bytes), retained.payload_sha256, 'retry original command bytes unchanged')
    const payload = JSON.parse(bytes)
    const point = JSON.parse(await fs.readFile(path.join(runtime, 'recovery-point.json'), 'utf8'))
    assert.equal(point.stage, stages[scenario])
    const world = await poll(observed, value => Object.keys(value.players).length === 4, 'restarted physical actors')
    const current = await state()
    assert.equal(current.state.readyForReview, false)
    assert.equal(world.stock['minecraft:redstone'], retained.stock_after_withdrawal, 'restart never recreates job stock')
    const afterEffect = ['crash-after-native-before-receipt', 'crash-after-applied-before-ack'].includes(scenario)
    const partial = scenario === 'partial-inventory-before-world-save'
    assert.equal(material(world), afterEffect ? 'minecraft:redstone_wire' : 'minecraft:air', 'actual restart target distinguishes before/after/partial')
    assert.equal(redstone(world), afterEffect || partial ? 0 : 1, 'actual carried item is never recreated')
    if (partial) assert.equal(current.state.quarantined, true, 'mixed durable world/inventory must quarantine')
    else await poll(state, value => !value.state.pendingOperation && !value.state.quarantined, 'known before/after recovery reconciled', 15000)
    const beforeRetry = await observed()
    const beforeRetryState = await state()
    const retry = await http('/command', payload, 'WorldBuilder')
    if (afterEffect) assert.equal(retry.body.status, 'REPLAY', 'known durable effect returns original receipt')
    else if (scenario === 'crash-after-intent') { assert.equal(retry.body.status, 'REFUSED'); assert.equal(retry.body.code, 'RECORDED_NOT_APPLIED') }
    else if (scenario === 'crash-before-intent') { assert.equal(retry.body.status, 'REFUSED'); assert.equal(retry.body.code, 'EXPIRED_OR_OVERLONG') }
    else assert.ok(!['REPLAY', 'APPLIED', 'PREPARED', 'AUTHORIZED'].includes(retry.body.status), 'partial unknown effect never replays')
    await delay(600)
    const afterRetry = await observed()
    const afterRetryState = await state()
    assert.equal(afterRetry.target_actual, beforeRetry.target_actual, 'retry has no additional world effect')
    assert.deepEqual(afterRetry.stock, beforeRetry.stock, 'retry has no additional stock effect')
    for (const name of Object.keys(beforeRetry.players)) assert.deepEqual(afterRetry.players[name].items, beforeRetry.players[name].items, 'retry has no additional actor inventory effect')
    assert.equal(afterRetryState.state.revision, beforeRetryState.state.revision)
    if (partial) assert.equal(afterRetryState.state.quarantined, true)
    step('actual_process_restart_recovery_and_original_payload_retry', { point, physical_before_retry: beforeRetry, durable_before_retry: beforeRetryState, retry, physical_after_retry: afterRetry, durable_after_retry: afterRetryState, expiry_is_past: payload.expiresAtMs < Date.now() })
    return
  }
  const initial = await observed()
  assert.equal(material(initial), 'minecraft:air')
  assert.equal(redstone(initial), 0)
  assert.equal((await state()).state.quarantined, false)
  const chest = await builder.openContainer(at(builder, [-14, 81, 5]))
  const withdrawal = await envelope('WITHDRAW', { item: 'minecraft:redstone', count: 1 })
  const transferred = await http('/command', withdrawal, 'WorldBuilder')
  assert.equal(transferred.body.status, 'APPLIED')
  const stock = await poll(observed, value => redstone(value) === 1 && value.stock['minecraft:redstone'] === initial.stock['minecraft:redstone'] - 1, 'real one-item custody transfer')
  chest.close()
  step('recovery_real_stock_withdrawal', { payload: withdrawal, receipt: transferred, before: initial, after: stock })
  builder.loadPlugin(pathfinder)
  const moves = new Movements(builder)
  moves.canDig = false; moves.allow1by1towers = false; moves.allowParkour = false; moves.maxDropDown = 1; moves.scafoldingBlocks = []
  moves.exclusionAreasBreak.push(() => 100); moves.exclusionAreasPlace.push(() => 100)
  moves.exclusionAreasStep.push(block => block.position.x < -18 || block.position.x > 17 || block.position.z < -10 || block.position.z > 9 || block.position.y < 80 || block.position.y > 83 ? 100 : 0)
  builder.pathfinder.setMovements(moves)
  await navigate(-15, 3); await navigate(-15, -6); await navigate(-2, -6)
  const item = builder.inventory.items().find(item => item.name === 'redstone')
  assert.ok(item)
  await builder.equip(item, 'hand')
  assert.equal(builder.heldItem.name, 'redstone')
  await delay(650)
  const payload = await envelope('PLACE', { x: target[0], y: target[1], z: target[2], state: 'minecraft:redstone_wire' })
  const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n')
  await fs.writeFile(path.join(runtime, 'recovery-operation.json'), bytes)
  await fs.writeFile(path.join(runtime, 'recovery-probe-state.json'), JSON.stringify({ payload_sha256: digest(bytes), stock_after_withdrawal: stock.stock['minecraft:redstone'], before_place: await observed(), payload }, null, 2) + '\n')
  if (scenario === 'crash-before-intent') {
    expectingCrash()
    await fs.writeFile(path.join(runtime, 'recovery-arm'), scenario + '\n')
    await poll(async () => fs.readFile(path.join(runtime, 'recovery-gate-ready'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), value => value === payload.operationId + '\n', 'sealed journal gate installed')
    try { report.pending_request_response = await http('/command', payload, 'WorldBuilder') } catch (error) { report.expected_connection_loss = error.message }
  } else {
    const prepared = await http('/command', payload, 'WorldBuilder')
    assert.equal(prepared.body.status, 'PREPARED', 'real command must reach durable intent before native fault')
    step('real_native_place_intent_durable', { payload, prepared, actual_before: await observed() })
    expectingCrash()
    await fs.writeFile(path.join(runtime, 'recovery-arm'), scenario + '\n')
    if (scenario !== 'crash-after-intent') {
      try { await builder.placeBlock(at(builder, support), builder.entity.position.offset(0, 1, 0).minus(builder.entity.position)) } catch (error) { report.native_call_during_expected_crash = error.message }
    }
  }
  const point = await poll(() => readOptional('recovery-point.json'), value => value?.stage === stages[scenario] && value.operation_id === payload.operationId, 'actual sealed process cut point', 25000)
  step('sealed_process_cut_point_proved_before_halt', { point, original_payload_sha256: digest(bytes) })
}
