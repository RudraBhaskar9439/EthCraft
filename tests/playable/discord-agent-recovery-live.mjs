// Read-only recovery of the already COMPLETE offline fixture wall. Never rebuild.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentManager } from '../../backend/src/playable/agents.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(import.meta.url)
const { Movements, goals } = require(join(root, 'tests/compatibility/node_modules/mineflayer-pathfinder'))
const ownerId = '50d0cfcd-2154-3460-a4cf-e6ccaa165a29', ownerName = 'TaskTester'
const directory = join(root, 'evidence/runs/playable-discord-recovery', randomUUID())
await mkdir(directory, { recursive: true })
const report = { status: 'fail', scope: 'Read-only path diagnosis/native stock observation and empty-agent release after the original offline wall completed; NO repeated build or item transfer', authentication: 'Explicit synthetic trusted authorization callback; no live Discord identity claim', independentHumansVerified: 0, publicTransactions: 0, checks: [] }
const check = (name, details = {}) => { report.checks.push({ name, status: 'pass', ...details }); console.log(JSON.stringify(report.checks.at(-1))) }
const json = async file => JSON.parse(await readFile(file, 'utf8'))
let manager, api, token, timer, pulseBusy = false
const grantId = randomUUID(), session = randomUUID(), expiresAtMs = Date.now() + 3_600_000, tools = ['status', 'inspect', 'wait']
const remote = action => ({ operationId: randomUUID(), ownerId, ownerName, action, args: '', grant: grantId, session })
async function offline() { assert.equal((await api('session?playerId=' + ownerId)).online, false) }
async function pulse() { if (pulseBusy) return; pulseBusy = true; try { await offline(); await api('remote-grant', { grantId, ownerId, slotName: 'CityAgent2', tools, generation: 1, expiresAtMs, leaseExpiresAtMs: Date.now() + 5000 }) } finally { pulseBusy = false } }
async function bounded(promise, label) { let timeout; try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(label)), 20000) })]) } finally { clearTimeout(timeout) } }
async function run() {
  const active = await json(join(root, '.local/playable-world/active.json')); assert.equal(active.owner, 'agentcity-playable-pilot')
  const runtime = join(root, '.local/playable-world', active.container)
  token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
  api = async (path, body) => { const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) }); assert.equal(response.status, 200); return response.json() }
  const configuration = await api('status'), region = configuration.taskRegions.find(value => value.slotName === 'CityAgent2')
  const agents = await json(join(runtime, 'personal-agents.json')), ruddy = agents.agents.find(slot => slot.name === 'CityAgent1')
  assert.equal(ruddy.ownerName, 'Ruddy'); assert.equal(agents.agents.find(slot => slot.name === 'CityAgent2')?.ownerId, ownerId)
  const tasks = await json(join(runtime, 'personal-agent-tasks.json')), wall = tasks.tasks.find(task => task.id === 'd2e377b8-f0ec-4e94-9819-9cdfa6667411')
  assert.equal(tasks.tasks.length, 11); assert(tasks.tasks.every(task => task.status === 'complete' && !task.pending)); assert.equal(Object.keys(wall.receipts).length, 5)
  const retained = JSON.stringify(wall.receipts)
  manager = await createAgentManager({ rootDirectory: root, runtimeDirectory: runtime, playWorld: configuration.playWorld, playSpawn: configuration.playSpawn, movementBounds: configuration.taskBounds, taskRegions: configuration.taskRegions,
    authorizeRemote: async request => { assert.equal(request.ownerId, ownerId); assert.equal(request.ownerName, ownerName); assert.equal(request.session, session); assert.equal(request.grant, grantId); assert(tools.includes(request.tool)); await pulse(); return { ownerPlayerId: ownerId, ownerName, slotName: 'CityAgent2', plotId: 'CityAgent2', grantId, tools, generation: 1, expiresAtMs } },
    onTaskLock: async (slot, task, state) => { assert.equal(slot.name, 'CityAgent2'); if (state.locked) await pulse(); return api('task-lock', { ownerId, slotName: 'CityAgent2', taskId: task.id, locked: state.locked, remoteGrantId: grantId, tool: 'inspect' }) }
  })
  timer = setInterval(() => { pulse().catch(() => {}) }, 1000)
  assert.match(await manager.handleRemote(remote('agent_create')), /CityAgent2 is your personal agent/)
  const bot = manager.getBot(ownerId), Vec = bot.entity.position.constructor, p = bot.entity.position
  report.initialObservation = { position: p.toArray(), health: bot.health, food: bot.food, blocks: [[0, -1, 0], [0, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, -1]].map(([x, y, z]) => { const block = bot.blockAt(new Vec(Math.floor(p.x) + x, Math.floor(p.y) + y, Math.floor(p.z) + z)); return { position: block?.position.toArray(), name: block?.name } }) }
  console.log(JSON.stringify({ observation: report.initialObservation }))
  const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.canOpenDoors = false; movements.scafoldingBlocks = []; movements.maxDropDown = 1
  movements.exclusionAreasBreak.push(() => Infinity); movements.exclusionAreasPlace.push(() => Infinity)
  movements.exclusionAreasStep.push(block => block.position.x >= region.min.x && block.position.x <= region.max.x && block.position.z >= region.min.z && block.position.z <= region.max.z ? 0 : Infinity)
  bot.pathfinder.setMovements(movements)
  async function cardinal(target) {
    const current = bot.entity.position, x0 = Math.floor(current.x), z0 = Math.floor(current.z)
    assert(x0 === target[0] || z0 === target[2], 'Recovery segments must be cardinal')
    for (let x = Math.min(x0, target[0]); x <= Math.max(x0, target[0]); x++) for (let z = Math.min(z0, target[2]); z <= Math.max(z0, target[2]); z++) {
      assert.equal(bot.blockAt(new Vec(x, region.min.y, z))?.boundingBox, 'empty', 'Observed recovery feet cells must be clear')
      assert.equal(bot.blockAt(new Vec(x, region.min.y + 1, z))?.boundingBox, 'empty', 'Observed recovery head cells must be clear')
      assert.equal(bot.blockAt(new Vec(x, region.min.y - 1, z))?.boundingBox, 'block', 'Observed recovery floor must exist')
    }
    await bounded(bot.pathfinder.goto(new goals.GoalNear(...target, 0)), 'Bounded cardinal recovery path failed'); bot.pathfinder.setGoal(null)
  }
  try {
    const west = region.min.x + 1, north = region.min.z + 1, east = region.max.x - 1
    if (bot.entity.position.x >= region.origin[0]) { await cardinal([east, region.min.y, Math.floor(bot.entity.position.z)]); await cardinal([east, region.min.y, north]); await cardinal([west, region.min.y, north]) }
    else { await cardinal([west, region.min.y, Math.floor(bot.entity.position.z)]); await cardinal([west, region.min.y, north]) }
    const reply = await manager.handleRemote(remote('agent_inspect')); assert.match(reply, /^Supplies checked/)
    const stock = manager.slots.find(slot => slot.name === 'CityAgent2').lastInspection
    assert.equal(stock.source.cobblestone, 46); assert.equal(stock.source.oak_planks, 63)
    check('fresh-native-stock-observed-through-clear-cardinal-east-north-west-route-without-repeating-effects', { sourceCobblestone: 46, sourceOakPlanks: 63 })
  } catch (error) { report.freshStockObservation = { status: 'blocked', reason: error.message, lastPosition: bot.entity.position.toArray() }; bot.pathfinder.setGoal(null) }
  assert.equal(bot.inventory.items().length, 0)
  assert.match(await manager.handleRemote(remote('agent_release')), /CityAgent2 was released/)
  assert.deepEqual((await json(join(runtime, 'personal-agents.json'))).agents, [ruddy])
  assert.equal(JSON.stringify(manager.tools.state.tasks.find(task => task.id === wall.id).receipts), retained)
  assert.equal(Object.keys(await json(join(runtime, 'plugins/AgentCity/task-region-locks.json'))).length, 0)
  await offline()
  check('empty-agent-released-original-eleven-completed-tasks-and-five-wall-receipts-unchanged-requester-stays-offline')
  report.status = report.freshStockObservation ? 'partial' : 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  clearInterval(timer); await manager?.close()
  if (api) await api('remote-grant', { grantId, ownerId, slotName: 'CityAgent2', revoked: true }).catch(error => { report.revokeError = error.message })
  report.finishedAt = new Date().toISOString()
  let publicJson = JSON.stringify(report, null, 2).replaceAll(root, '[workspace]'); if (token) publicJson = publicJson.replaceAll(token, '[REDACTED]')
  await writeFile(join(directory, 'report.json'), publicJson + '\n'); console.log(publicJson); console.log('Evidence ' + directory)
})
