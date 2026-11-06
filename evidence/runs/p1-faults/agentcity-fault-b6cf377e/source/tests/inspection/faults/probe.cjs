'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const mineflayer = require(path.join(process.env.AC_FAULT_MODULE_ROOT, 'mineflayer'))
const runtime = process.env.AC_FAULT_RUNTIME
const token = process.env.AC_FAULT_TOKEN
const phase = process.env.AC_FAULT_PHASE || 'initial'
const clients = []
const sessions = new Map()
const secrets = new Set([token])
const report = { schema: 'agentcity.p1.fault-client.v1', status: 'fail', phase, started_at: new Date().toISOString(), full_phase_gate_passed: false, steps: [] }
let closing = false
let stopped
let lastConnect = -Infinity
let expectedCrash = false
const stop = error => { if (expectedCrash) { (report.expected_disconnects ||= []).push(error.message) } else if (!closing && !stopped) stopped = error }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function clean (value) {
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('<redacted-credential>'); return value }
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clean(val)]))
  return value
}
async function poll (read, predicate, label, timeout = 15000) {
  const deadline = performance.now() + timeout
  let value
  while (performance.now() < deadline) {
    if (stopped) throw stopped
    value = await read()
    if (predicate(value)) return value
    await delay(150)
  }
  throw new Error(`${label} not observed: ${JSON.stringify(clean(value))}`)
}
async function connect (username) {
  if (stopped) throw stopped
  await delay(Math.max(0, 4250 - (performance.now() - lastConnect)))
  lastConnect = performance.now()
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25583, username, version: '1.21.11', auth: 'offline' })
  clients.push(bot)
  bot.on('messagestr', text => {
    if (!text.startsWith('AC_SESSION ')) return
    const parts = text.trim().split(/\s+/)
    if (parts.length === 3 && parts[1] === bot.player?.uuid) { sessions.set(username, parts[2]); secrets.add(parts[2]) }
  })
  bot.on('error', error => stop(new Error(`${username}: ${error.message}`)))
  bot.on('kicked', reason => stop(new Error(`${username} kicked: ${JSON.stringify(reason)}`)))
  bot.on('end', reason => stop(new Error(`${username} ended: ${reason}`)))
  await Promise.race([new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject); bot.once('kicked', reason => reject(new Error(`${username} kicked before spawn: ${JSON.stringify(reason)}`))); bot.once('end', reason => reject(new Error(`${username} ended before spawn: ${reason}`))) }), delay(15000).then(() => { throw stopped || new Error(`${username} spawn timeout`) })])
  await bot.waitForChunksToLoad()
  assert.equal(bot.game.gameMode, 'survival')
  if (username !== 'WorldStranger') await poll(async () => sessions.get(username), Boolean, `${username} session`)
  return bot
}
async function http (route, body, actor) {
  const headers = { Authorization: `Bearer ${token}` }
  if (actor) headers['X-AgentCity-Session'] = sessions.get(actor)
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:25582${route}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(16000) })
  return { http_status: response.status, body: await response.json() }
}
async function state () { const value = await http('/status'); assert.equal(value.http_status, 200); return value.body }
async function observed () { return JSON.parse(await fs.readFile(path.join(runtime, 'fault-observation.json'), 'utf8')) }
const step = (name, fields) => { report.steps.push({ name, at: new Date().toISOString(), ...fields }); console.log(JSON.stringify({ step: name })) }
async function run () {
  assert.ok(runtime && token && token.length >= 32)
  const plan = JSON.parse(await fs.readFile(path.join(runtime, 'boundary-fixture.json'), 'utf8'))
  report.scenario = plan.fault_scenario
  report.declared_variant_ids = plan.declared_variant_ids
  const bots = {}
  for (const name of ['WorldBuilder', 'WorldRequester', 'WorldInspector', 'WorldStranger']) bots[name] = await connect(name)
  await delay(4500)
  const before = await poll(state, value => !value.state.pendingOperation, 'stable initial durable state')
  const worldBefore = await poll(observed, value => Object.keys(value.players).length === 4 && !value.fixture_error, 'actual fixture actors and blocks')
  report.initial_durable_state = before
  report.initial_actual_observation = worldBefore
  report.initial_client_port_materials = Object.fromEntries(Object.entries(worldBefore.ports).map(([name, port]) => {
    const p = port.position
    const bot = bots.WorldInspector
    const block = bot.blockAt(bot.entity.position.offset(p[0] - bot.entity.position.x, p[1] - bot.entity.position.y, p[2] - bot.entity.position.z))
    return [name, block ? block.name : 'UNAVAILABLE_CLIENT_CHUNK']
  }))
  assert.equal(before.state.readyForReview, false)
  if (plan.recovery_scenario) {
    await require('./recovery.cjs')({ runtime, plan, phase, bots, report, poll, observed, state, http, step, delay, expectingCrash: () => { expectedCrash = true } })
    report.status = 'pass'
    return
  }
  if (phase === 'restart') {
    const prior = JSON.parse(await fs.readFile(path.join(runtime, 'fault-probe-state.json'), 'utf8'))
    assert.equal(before.state.readyForReview, false, 'restart cannot invent readiness')
    if (prior.state.lockMode !== 'NONE') assert.ok(before.state.lockMode !== 'NONE' || before.state.quarantined, 'known retained lock must survive or fail closed')
    for (const [filename, digest] of Object.entries(prior.reports)) assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(runtime, 'plugins/AgentCity/reports', filename))).digest('hex'), digest, 'restart must preserve original incomplete report bytes')
    step('restart_preserves_no_readiness_and_report_bytes', { before, world: worldBefore, prior_lock: prior.state.lockMode })
    report.status = 'pass'
    return
  }
  assert.equal(before.state.quarantined, false, 'new fixture begins without ambiguous effect')
  const directory = path.join(runtime, 'plugins/AgentCity/reports')
  const existing = new Set(await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
  const payload = { operationId: crypto.randomUUID(), serverId: plan.deployment.serverId, jobId: plan.deployment.jobId, agreementVersion: plan.deployment.agreementVersion, actorId: bots.WorldInspector.player.uuid, expectedRevision: before.state.revision, authorizationReference: plan.deployment.authorizationReference, expiresAtMs: Date.now() + 8000, action: 'INSPECT', params: {} }
  if (!plan.fault_scenario.endsWith('-preflight')) await fs.writeFile(path.join(runtime, 'fault-arm'), plan.fault_scenario + '\n')
  const response = await http('/command', payload, 'WorldInspector')
  if (plan.fault_scenario.endsWith('-preflight')) {
    assert.equal(response.body.status, 'REFUSED', 'missing/wrong structure must refuse before checker')
    assert.match(response.body.code, /blueprint_structure_mismatch|input_|lamp_|support_/)
    const after = await state()
    for (const key of ['revision', 'lockMode', 'quarantined', 'readyForReview', 'pendingOperation']) assert.deepEqual(after.state[key], before.state[key], `preflight refusal leaves ${key} unchanged`)
    assert.equal(after.state.readyForReview, false)
    const files = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    assert.equal(files.filter(name => name.endsWith('.json') && !existing.has(name)).length, 0, 'preflight refusal does not fabricate an inspection report')
    const worldAfter = await observed()
    assert.deepEqual(worldAfter.stock, worldBefore.stock, 'preflight leaves real stock unchanged')
    for (const name of Object.keys(worldBefore.players)) assert.deepEqual(worldAfter.players[name].items, worldBefore.players[name].items, 'preflight leaves actor inventory unchanged')
    step('typed_preflight_refusal_no_readiness', { payload, response, before, after, world_before: worldBefore, world_after: worldAfter })
  } else {
    assert.equal(response.body.status, 'APPLIED', 'protected inspection must really start')
    const active = await poll(state, value => value.state.lockMode === 'INSPECTION' && !value.state.pendingOperation, 'genuine durable inspection lock')
    const fault = await poll(observed, value => value.fault_applied || value.fixture_error, 'sealed fault at exact active checker barrier', 80000)
    assert.ok(!fault.fixture_error, fault.fixture_error)
    if (plan.fault_scenario.startsWith('unloaded-chunk')) assert.equal(fault.target_chunk_loaded, false, 'required chunk must really be unloaded')
    const files = await poll(async () => (await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => name.endsWith('.json') && !existing.has(name)), value => value.length > 0, 'new retained incomplete checker report', 35000)
    assert.equal(files.length, 1)
    const bytes = await fs.readFile(path.join(directory, files[0]))
    const inspection = JSON.parse(bytes)
    assert.equal(inspection.status, 'INCOMPLETE')
    assert.ok(inspection.reason)
    assert.ok(inspection.rows.length < 16)
    const after = await state()
    assert.equal(after.state.readyForReview, false, 'missing observation cannot create readiness')
    const worldAfter = await observed()
    assert.deepEqual(worldAfter.stock, worldBefore.stock, 'sealed observation fault does not charge stock')
    for (const name of Object.keys(worldBefore.players)) assert.deepEqual(worldAfter.players[name].items, worldBefore.players[name].items, 'sealed fault leaves actor inventory unchanged')
    step('active_fault_produces_retained_incomplete_no_readiness', { payload, response, active, actual_fault: fault, inspection, after, report_file: files[0], report_sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  const last = await state()
  const reports = {}
  for (const name of await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) if (name.endsWith('.json')) reports[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')
  await fs.writeFile(path.join(runtime, 'fault-probe-state.json'), JSON.stringify({ scenario: plan.fault_scenario, state: last.state, reports }, null, 2) + '\n')
  report.status = 'pass'
}
const timeout = setTimeout(() => stop(new Error('Fault probe overall deadline')), 170000)
run().catch(async error => { report.error = { name: error.name, message: error.message, stack: error.stack }; try { report.final_state = await state(); report.final_observation = await observed() } catch {} process.exitCode = 1 }).finally(async () => {
  closing = true; clearTimeout(timeout)
  for (const bot of clients) { try { bot.clearControlStates(); bot.quit('Sealed fault observations retained') } catch {} }
  report.finished_at = new Date().toISOString()
  await fs.writeFile(process.env.AC_FAULT_REPORT, JSON.stringify(clean(report), null, 2) + '\n')
  console.log(JSON.stringify(clean({ status: report.status, scenario: report.scenario, error: report.error })))
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref()
})
