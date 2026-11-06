// Native offline-owner execution and image proof. Authentication is an EXPLICIT
// injected trusted fixture, not Discord OAuth, a Discord user, or a human client.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { createAgentManager } from '../../backend/src/playable/agents.mjs'
import { captureWorldScreenshot } from '../../backend/src/playable/world-screenshot.mjs'
import { localOllama } from '../../backend/src/inference/providers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const ownerId = '50d0cfcd-2154-3460-a4cf-e6ccaa165a29', ownerName = 'TaskTester'
const runId = randomUUID(), directory = join(root, 'evidence/runs/playable-discord-agent', runId)
await mkdir(directory, { recursive: true })
const report = { status: 'fail', scope: 'Actual native offline-Minecraft-owner wall construction, receiving isolation and observed-world PNG; trusted Discord authorization is a synthetic injected fixture', authentication: 'SYNTHETIC TRUSTED CALLBACK; no Discord OAuth or live Discord delivery proof', independentHumansVerified: 0, liveDiscordIdentitiesVerified: 0, publicTransactions: 0, startedAt: new Date().toISOString(), checks: [] }
const check = (name, details = {}) => { report.checks.push({ name, status: 'pass', ...details }); console.log(JSON.stringify(report.checks.at(-1))) }
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const grantId = randomUUID(), expiredGrantId = randomUUID(), session = randomUUID(), expiresAtMs = Date.now() + 3_600_000
const tools = ['status', 'inspect', 'screenshot', 'wait', 'build']
let token, runtime, api, manager, pulseTimer, offlineTimer, pulseBusy = false, monitorBusy = false, backgroundError, requesterChecks = 0
let images = [], notices = [], grantInstalled = false
const remote = (action, args = '') => ({ operationId: randomUUID(), ownerId, ownerName, action, args, grant: grantId, session })
async function requesterOffline() {
  const current = await api('session?playerId=' + ownerId)
  requesterChecks++
  assert.equal(current.online, false, 'No human Minecraft requester may connect during this fixture')
  return true
}
async function pulse() {
  if (pulseBusy) return
  pulseBusy = true
  try {
    await api('remote-grant', { grantId, ownerId, slotName: 'CityAgent2', tools, generation: 1, expiresAtMs, leaseExpiresAtMs: Math.min(expiresAtMs, Date.now() + 5000) })
    grantInstalled = true
  } finally { pulseBusy = false }
}
async function poll(read, accept, label, timeout = 180000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (backgroundError) throw backgroundError
    const value = await read()
    if (accept(value)) return value
    await sleep(200)
  }
  throw Error('Timed out: ' + label)
}
async function workflowAfter(request) {
  const message = await manager.handleRemote(request)
  if (!message.includes('Workflow accepted')) throw Error('The actual model did not start the requested workflow: ' + message)
  return poll(() => manager.intents.workflow(ownerId), workflow => workflow?.id === request.operationId && ['complete', 'paused'].includes(workflow.status), 'observed remote workflow completion')
}
async function run() {
  const active = await json(join(root, '.local/playable-world/active.json'))
  assert.equal(active.owner, 'agentcity-playable-pilot'); assert.match(active.container, /^agentcity-playable-[a-f0-9]{8}$/)
  runtime = join(root, '.local/playable-world', active.container)
  token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
  api = async (suffix, body) => {
    const response = await fetch('http://127.0.0.1:25597/playable/' + suffix, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw Error('Native plugin API failed: ' + suffix.split('?')[0] + ' HTTP' + response.status)
    return response.json()
  }
  const configuration = await api('status'), region = configuration.taskRegions.find(value => value.slotName === 'CityAgent2')
  assert(region); assert.equal(configuration.playWorld, 'agentcity_play')
  const beforeAgents = await json(join(runtime, 'personal-agents.json'))
  const ruddy = beforeAgents.agents.find(slot => slot.name === 'CityAgent1')
  assert.equal(ruddy?.ownerName, 'Ruddy'); assert(!beforeAgents.agents.some(slot => slot.name === 'CityAgent2'), 'Do not rerun over an occupied or partially completed fixture; preserve its receipts for explicit reconciliation')
  const beforeTasks = await json(join(runtime, 'personal-agent-tasks.json'))
  assert.equal(beforeTasks.tasks.length, 10, 'Expected the retained ten-task checkpoint')
  assert(beforeTasks.tasks.every(task => task.status === 'complete' && !task.pending))
  await requesterOffline()
  const settings = await json(join(runtime, 'agent-settings.json'))
  assert.equal(settings.model, 'qwen3:4b')
  const expectedCells = [[-45, 64, 10], [-44, 64, 10], [-45, 65, 10], [-44, 65, 10]]
  manager = await createAgentManager({ rootDirectory: root, runtimeDirectory: runtime, gamePort: 25596,
    modelProvider: { ...localOllama, model: settings.model }, playWorld: configuration.playWorld, playSpawn: configuration.playSpawn,
    movementBounds: configuration.taskBounds, taskRegions: configuration.taskRegions,
    authorizeRemote: async request => {
      if (request.session !== session || request.ownerId !== ownerId || request.ownerName !== ownerName || request.agentId !== 'CityAgent2' || request.plotId !== 'CityAgent2' || !tools.includes(request.tool)) throw Error('SYNTHETIC_FIXTURE_AUTH_REFUSED')
      if (request.grant === expiredGrantId) return { ownerPlayerId: ownerId, ownerName, slotName: 'CityAgent2', plotId: 'CityAgent2', grantId: expiredGrantId, tools, generation: 1, expiresAtMs: Date.now() - 1000 }
      if (request.grant !== grantId) throw Error('SYNTHETIC_FIXTURE_GRANT_REFUSED')
      await requesterOffline(); await pulse()
      return { ownerPlayerId: ownerId, ownerName, principalId: ownerId, slotName: 'CityAgent2', agentId: 'CityAgent2', plotId: 'CityAgent2', grantId, tools, generation: 1, expiresAtMs }
    },
    onTaskLock: async (slot, task, state) => {
      assert.equal(slot.name, 'CityAgent2'); assert.equal(slot.ownerId, ownerId)
      if (state.locked) { await requesterOffline(); await pulse() }
      return api('task-lock', { slotName: slot.name, ownerId, taskId: task.id, locked: state.locked, remoteGrantId: grantId, tool: task.plan?.action || 'inspect' })
    },
    onTaskResult: async (id, message) => { assert.equal(id, ownerId); notices.push(String(message)) },
    screenshotHandler: async ({ bot, ownerId: actor, slotName }) => {
      assert.equal(actor, ownerId); assert.equal(slotName, 'CityAgent2'); assert.equal(bot, manager.getBot(ownerId)); await requesterOffline()
      const image = await captureWorldScreenshot(bot, { bounds: { min: { ...region.min, y: region.min.y - 1 }, max: region.max }, target: { x: -44, y: 65, z: 10.5 }, worldName: configuration.playWorld, outputDirectory: directory })
      images.push(image)
      return { complete: true, message: 'Captured the actual observed agent world view; this fixture does not deliver Discord messages.' }
    }
  })
  // Root runs this script only after stopping the main owned worker. Running it
  // in WSL uses that worker's canonical journal lease, not a second alias path.
  pulseTimer = setInterval(() => { pulse().catch(error => { backgroundError = error }) }, 1000)
  offlineTimer = setInterval(() => {
    if (monitorBusy) return
    monitorBusy = true
    requesterOffline().catch(error => { backgroundError = error; manager.revokeRemote(grantId).catch(() => {}) }).finally(() => { monitorBusy = false })
  }, 1000)
  const created = await manager.handleRemote(remote('agent_create'))
  assert.match(created, /CityAgent2 is your personal agent/)
  const bot = manager.getBot(ownerId)
  assert(bot); assert.equal(manager.ownerOnline(manager.slots.find(slot => slot.name === 'CityAgent2')), false)
  assert.equal(bot.players?.[ownerName], undefined, 'Do not insert or join a fake human')
  assert.equal(bot.game.gameMode, 'survival')
  await manager.handleRemote(remote('agent_inspect'))
  const observed = manager.slots.find(slot => slot.name === 'CityAgent2').lastInspection
  assert(observed, 'A real native material inspection must finish before construction')
  assert.equal(observed.source.cobblestone, 50); assert.equal(observed.source.oak_planks, 63)
  const Vec = bot.entity.position.constructor
  assert(expectedCells.every(position => ['air', 'cave_air', 'void_air'].includes(bot.blockAt(new Vec(...position))?.name)), 'The new wall footprint must be unused; never reset an existing build')
  check('native-agent-connects-and-inspects-real-stock-with-requester-offline-and-all-retained-builds-preserved', { sourceCobblestone: 50, sourceOakPlanks: 63, retainedCompletedTasks: 10 })
  assert.match(await manager.handleRemote({ ...remote('agent_status'), ownerId: ruddy.ownerId, ownerName: ruddy.ownerName }), /refused/)
  assert.match(await manager.handleRemote({ ...remote('agent_status'), grant: expiredGrantId }), /refused/)
  assert.equal(manager.tools.state.tasks.length, 10)
  check('wrong-owner-and-expired-trusted-fixture-grants-authorize-no-new-task')

  const buildRequest = remote('agent_task', 'Build a cobblestone wall two blocks wide, one block thick and two blocks high at relative offset [0,0,6] in my own plot.')
  report.buildOperationId = buildRequest.operationId
  const completed = await workflowAfter(buildRequest)
  report.buildWorkflow = { id: completed.id, status: completed.status, message: completed.message }
  assert.equal(completed.status, 'complete', completed.message)
  const task = manager.tools.state.tasks.find(value => value.operationId === buildRequest.operationId + ':step:0')
  assert(task); assert.equal(task.status, 'complete'); assert.equal(task.pending, null)
  assert.equal(task.plan.action, 'build_structure'); assert.equal(task.plan.structure, 'wall')
  assert.equal(task.plan.placements.length, 4); assert.equal(task.materialCount, 4); assert.equal(task.preexisting.length, 0)
  assert.deepEqual(task.plan.placements.map(block => block.position.join(',')).sort(), expectedCells.map(position => position.join(',')).sort())
  assert(expectedCells.every(position => bot.blockAt(new Vec(...position))?.name === 'cobblestone'))
  const withdrawal = Object.values(task.receipts).filter(receipt => receipt.before?.chest && receipt.after?.chest)
  assert.equal(withdrawal.length, 1); assert.equal(withdrawal[0].before.chest.cobblestone, 50); assert.equal(withdrawal[0].after.chest.cobblestone, 46)
  assert.equal(Object.keys(task.receipts).filter(id => id.startsWith(task.operationId + ':place:')).length, 4)
  assert.equal(Object.keys(task.receipts).length, 5)
  const beforeRetry = JSON.stringify(task.receipts)
  await manager.handleRemote(buildRequest); await manager.tools.idle()
  assert.equal(JSON.stringify(task.receipts), beforeRetry); assert.equal(manager.tools.state.tasks.length, 11)
  check('actual-natural-language-offline-wall-has-four-real-cells-one-four-item-withdrawal-four-placement-receipts-and-zero-extra-retry-effects', { taskId: task.id, workflowId: completed.id, sourceCobblestoneBefore: 50, sourceCobblestoneAfter: 46, realPlacements: 4, receivingReceipts: 5 })

  const update = remote('agent_task', 'What is the update? Share a screenshot of your actual view as well.')
  const updateFlow = await workflowAfter(update)
  assert.equal(updateFlow.status, 'complete', updateFlow.message)
  assert.deepEqual(updateFlow.steps.map(step => step.action), ['status', 'screenshot'])
  assert.equal(images.length, 1)
  const image = images[0]
  assert.equal(image.metadata.agent, 'CityAgent2'); assert.equal(image.metadata.world, configuration.playWorld)
  assert.match(image.metadata.observedBlockHash, /^[a-f0-9]{64}$/)
  assert.equal(createHash('sha256').update(await readFile(image.file)).digest('hex'), image.metadata.pngSha256)
  report.image = { file: relative(root, image.file).replaceAll('\\', '/'), metadataFile: relative(root, image.file + '.json').replaceAll('\\', '/'), pngSha256: image.metadata.pngSha256, observedBlockHash: image.metadata.observedBlockHash, provenance: image.metadata.source, captureId: image.metadata.captureId }
  check('actual-update-plus-screenshot-intent-renders-current-native-observations-with-png-hash-and-provenance', report.image)
  const finalInspectionReply = await manager.handleRemote(remote('agent_inspect'))
  assert.match(finalInspectionReply, /^Supplies checked/, 'A failed fresh inspection must not reuse an older cached stock snapshot')
  const after = manager.slots.find(slot => slot.name === 'CityAgent2').lastInspection
  assert.equal(after.source.cobblestone, 46); assert.equal(after.source.oak_planks, 63)
  assert.equal(bot.inventory.items().length, 0)
  assert.match(await manager.handleRemote(remote('agent_release')), /CityAgent2 was released/)
  assert.deepEqual((await json(join(runtime, 'personal-agents.json'))).agents, [ruddy])
  assert.equal(Object.keys(await json(join(runtime, 'plugins/AgentCity/task-region-locks.json'))).length, 0)
  await requesterOffline()
  check('empty-fixture-agent-released-source-materials-reconciled-ruddy-owner-unchanged-and-requester-never-joined', { sourceCobblestone: 46, sourceOakPlanks: 63, requesterOfflineObservations: requesterChecks })
  report.status = 'pass'
}
run().catch(error => { report.error = error.message; process.exitCode = 1 }).finally(async () => {
  clearInterval(pulseTimer); clearInterval(offlineTimer)
  await manager?.close().catch(error => { report.closeError = error.message; process.exitCode = 1 })
  if (grantInstalled) await api('remote-grant', { grantId, ownerId, slotName: 'CityAgent2', revoked: true }).catch(error => { report.revokeError = error.message; process.exitCode = 1 })
  report.finishedAt = new Date().toISOString(); report.requesterOfflineObservations = requesterChecks
  if (manager) report.retainedTasks = manager.tools.status(ownerId).map(task => ({ id: task.id, action: task.action, status: task.status, completed: task.completed, total: task.total }))
  if (report.closeError || report.revokeError) report.status = 'fail'
  let publicJson = JSON.stringify(report, null, 2).replaceAll(root, '[workspace]')
  if (token) publicJson = publicJson.replaceAll(token, '[REDACTED]')
  await writeFile(join(directory, 'report.json'), publicJson + '\n')
  console.log(publicJson); console.log('Evidence ' + directory)
})
