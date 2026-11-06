'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const mineflayer = require(path.join(root, 'tests/compatibility/node_modules/mineflayer'))
const { structural } = require(path.join(root, 'backend/src/bot/construction-worker.cjs'))
const runtime = process.env.AGENTCITY_RESTORE_RUNTIME
const token = process.env.AGENTCITY_API_TOKEN
const gamePort = Number(process.env.AGENTCITY_RESTORE_GAME_PORT || 25594)
const controlPort = Number(process.env.AGENTCITY_RESTORE_CONTROL_PORT || 25595)
assert.ok([gamePort, controlPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535))
const report = { status: 'fail', scope: 'Actual isolated restored Minecraft world; internal materials only', checks: [] }
let bot, session
const clients = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = async file => JSON.parse(await fs.readFile(path.join(runtime, file), 'utf8'))
async function poll(readValue, accepts, milliseconds = 20000) {
  const until = performance.now() + milliseconds
  do { const value = await readValue(); if (accepts(value)) return value; await delay(250) } while (performance.now() < until)
  throw new Error('Restored world observation timed out')
}
async function status() {
  const result = await fetch(`http://127.0.0.1:${controlPort}/status`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })
  assert.equal(result.status, 200)
  return (await result.json()).state
}
function uuid(name) {
  const bytes = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
async function run() {
  const deployment = await read('plugins/AgentCity/deployment.json')
  const blueprint = await read('plugins/AgentCity/blueprint.json')
  const before = await status()
  assert.equal(before.revision, 144)
  const observed = await poll(() => read('construction-observation.json'), value => value.observed_at_ms >= Number(process.env.AGENTCITY_RESTORE_STARTED_MS))
  const origin = deployment.plotMin.map((coordinate, axis) => coordinate + [4, 1, 4][axis])
  for (const placement of blueprint.placements) {
    const position = placement.position.map((n, i) => n + origin[i]).join(',')
    const actual = observed.blocks[position]
    assert.ok(actual, 'Missing restored block: ' + position)
    const start = actual.indexOf('[')
    const properties = start < 0 ? {} : Object.fromEntries(actual.slice(start + 1, -1).split(',').map(pair => pair.split('=')))
    const expected = { ...placement.properties }
    if (placement.block === 'minecraft:lever' && expected.facing === undefined) expected.facing = 'north'
    assert.equal(structural(start < 0 ? actual : actual.slice(0, start), properties), structural(placement.block, expected))
  }
  assert.equal(blueprint.placements.length, 144)
  assert.deepEqual(observed.stock, {})
  report.checks.push('fresh server observations preserve all 144 structural block states, empty stock and durable revision 144')
  const oldReports = new Set(await fs.readdir(path.join(runtime, 'plugins/AgentCity/reports')))
  const eventsBefore = await fs.readFile(path.join(runtime, 'construction-events.jsonl'), 'utf8')
  async function connect(name) {
    const options = { host: '127.0.0.1', port: gamePort, username: name, auth: 'offline', version: '1.21.11' }
    const client = process.env.AGENTCITY_MINECRAFT_PROFILE === 'maintained'
      ? require(path.join(root, 'backend/src/bot/client-protocol.cjs')).createMaintainedBot(mineflayer, options, runtime)
      : mineflayer.createBot(options)
    clients.push(client)
    client.on('messagestr', message => { const fields = message.split(' '); if (fields[0] === 'AC_SESSION' && fields[1] === uuid('WorldInspector')) session = fields[2] })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Restored fixture actor spawn timed out')), 20000)
      client.once('spawn', () => { clearTimeout(timeout); resolve() })
      client.once('error', error => { clearTimeout(timeout); reject(error) })
      client.once('kicked', () => { clearTimeout(timeout); reject(new Error('Restored fixture actor was refused')) })
    })
    if (process.env.AGENTCITY_MINECRAFT_PROFILE === 'maintained') await client.waitForChunksToLoad()
    return client
  }
  await connect('WorldBuilder')
  await delay(4200)
  await connect('WorldRequester')
  await delay(4200)
  bot = await connect('WorldInspector')
  await poll(async () => session, Boolean)
  const online = await poll(() => read('construction-observation.json'), value => value.players.WorldBuilder && value.players.WorldRequester && value.players.WorldInspector)
  assert.deepEqual(online.players.WorldBuilder.items, {})
  assert.deepEqual(online.players.WorldRequester.items, {})
  await delay(700)
  async function command(action) {
    const current = await status()
    const response = await fetch(`http://127.0.0.1:${controlPort}/command`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'X-AgentCity-Session': session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: crypto.randomUUID(), serverId: deployment.serverId, jobId: deployment.jobId,
        agreementVersion: deployment.agreementVersion, actorId: uuid('WorldInspector'), expectedRevision: current.revision,
        authorizationReference: deployment.authorizationReference, expiresAtMs: Date.now() + 8000, action, params: {} }),
      signal: AbortSignal.timeout(15000)
    })
    assert.equal(response.status, 200)
    const receipt = await response.json()
    assert.equal(receipt.status, 'APPLIED', JSON.stringify(receipt))
  }
  const restoredState = await status()
  if (restoredState.lockMode === 'REVIEW') {
    const remaining = Math.max(0, restoredState.passValidUntilMs - Date.now() + 200)
    assert.ok(Number.isFinite(remaining) && remaining <= 35000, 'Unexpected local pass validity; keep the restored lock.')
    await delay(remaining)
    await command('UNLOCK')
    assert.equal((await status()).lockMode, 'NONE')
    report.checks.push('the restored local review lock is released only after its recorded pass validity expires')
    await delay(700)
  }
  await command('INSPECT')
  const inspection = await poll(async () => {
    const files = await fs.readdir(path.join(runtime, 'plugins/AgentCity/reports'))
    const added = files.find(file => !oldReports.has(file))
    return added ? read('plugins/AgentCity/reports/' + added) : null
  }, value => value?.rows?.length === 16, 240000)
  assert.equal(inspection.status, 'PASS')
  assert.ok(inspection.rows.every(row => row.observed === row.expected))
  const ready = await poll(status, value => value.readyForReview)
  assert.equal(ready.revision, 144)
  assert.equal(ready.lockMode, 'REVIEW')
  const eventsAfter = await fs.readFile(path.join(runtime, 'construction-events.jsonl'), 'utf8')
  assert.ok(!eventsAfter.slice(eventsBefore.length).split('\n').filter(Boolean).map(JSON.parse).some(event => event.event === 'native_place' && !event.cancelled))
  report.checks.push('a newly authenticated fixture inspector obtains a new real 16/16 lamp report and retained review lock without placing or replenishing blocks')
  report.inspection = inspection
  report.status = 'pass'
}
run().catch(error => { report.error = { type: error.name, message: error.message.replaceAll(token || '\0', '<redacted>') }; process.exitCode = 1 })
  .finally(async () => { for (const client of clients) client.quit('isolated restore check complete'); await fs.writeFile(path.join(runtime, 'restore-check.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, checks: report.checks.length })) })
