import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentManager } from '../backend/src/playable/agents.mjs'
import { comparisonOwners, scoreArch, scoreBench } from './compare_agents.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function inventory(bot) {
  const totals = {}
  for (const item of bot.inventory.items()) totals[item.name] = (totals[item.name] || 0) + item.count
  return totals
}
async function save(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
}
function cells(bot, region, offset, size) {
  const result = {}, Vec = bot.entity.position.constructor
  for (let x = 0; x < size[0]; x++) for (let y = 0; y < size[1]; y++) for (let z = 0; z < size[2]; z++) {
    const position = region.origin.map((n, i) => n + offset[i] + [x, y, z][i])
    const block = bot.blockAt(new Vec(...position))
    assert(block, 'Recovery requires an actual loaded block observation.')
    result[[x, y, z].join(',')] = block.name
  }
  return result
}
const taskSummary = task => task ? ({ id: task.id, operationId: task.operationId, status: task.status, completed: [...task.completed], pending: task.pending,
  receipts: Object.fromEntries(Object.entries(task.receipts).map(([id, receipt]) => [id, { before: receipt.before, after: receipt.after, observedAt: receipt.observedAt }])) }) : null
export function validateRecoveryTask(bench, workflow, task, owner) {
  assert(task && workflow && owner)
  assert.equal(owner.slotName, 'CityAgent3'); assert.equal(task.slotName, owner.slotName)
  assert.equal(workflow.id, bench.operationId); assert.equal(task.operationId, bench.operationId + ':step:0')
  assert.equal(task.ownerId, owner.ownerId); assert.equal(task.materialCount, 14)
  assert.equal(workflow.steps.length, 1); assert.equal(workflow.steps[0].action, 'build_structure')
  assert(['paused', 'reconciliation_required', 'blocked'].includes(task.status), 'Recovery may not replay an already completed task.')
}

async function main() {
  const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1]
  if (!args.includes('--run') || !args.includes('--report') || !args.includes('--expected-report-sha256')) {
    console.log('Usage: node scripts/recover_agent_comparison.mjs --run --serve --report /absolute/original/report.json --expected-report-sha256 HASH')
    console.log('Stop the comparison daemon first. This only resumes its original Claude bench; all model calls are disabled.')
    return
  }
  const originalFile = resolve(flag('--report')), originalBytes = await readFile(originalFile), originalHash = hash(originalBytes)
  assert.equal(originalHash, flag('--expected-report-sha256'), 'The immutable original comparison changed.')
  const original = JSON.parse(originalBytes), bench = original.trials.find(trial => trial.trial === 'bench' && trial.slotName === 'CityAgent3')
  assert.equal(original.status, 'partial'); assert.equal(bench?.status, 'failed')
  const sessions = await json(join(dirname(originalFile), 'controlled-sessions.json'))
  assert.equal(sessions.length, 2)
  const owner = sessions.find(value => value.slotName === 'CityAgent3')
  for (const expected of comparisonOwners) {
    const session = sessions.find(value => value.slotName === expected.slotName)
    assert.equal(session?.ownerId, expected.ownerId); assert.equal(session?.ownerName, expected.ownerName)
    assert(session.expiresAtMs > Date.now() + 600000, 'Existing scoped grants must remain valid throughout recovery.')
  }
  const active = await json(join(root, '.local/playable-world/active.json'))
  assert.equal(active.owner, 'agentcity-playable-pilot')
  const runtime = join(root, '.local/playable-world', active.container), token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
  const api = async (path, body) => {
    const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw Error('RECOVERY_NATIVE_HTTP_' + response.status)
    return response.json()
  }
  const world = await api('status'), region = world.taskRegions.find(value => value.slotName === owner.slotName)
  assert.equal(world.playWorld, 'agentcity_play'); assert(region)
  const settings = await json(join(root, '.local/comparison/providers.json'))
  const budgetHashes = Object.fromEntries(await Promise.all(Object.entries(settings).map(async ([slot, config]) => [slot, hash(await readFile(config.budgetFile))])))
  const recoveryId = randomUUID(), output = join(dirname(originalFile), 'recovery-' + recoveryId + '.json')
  const report = { version: 1, recoveryId, sourceRunId: original.runId, originalReportSha256: originalHash, startedAt: new Date().toISOString(), status: 'running',
    disclosure: 'Inference-disabled recovery of the original Claude-generated immutable bench, not a rerun or a successful original comparison. Controlled owner fixtures; no blockchain actions, new model decisions, material replenishment or block deletion.',
    modelCallsAttempted: 0, notices: [] }
  const tools = ['status', 'inspect', 'wait', 'build', 'deliver']
  let manager, timer, pulsing = false, backgroundError
  const pulse = async () => {
    if (pulsing) return
    pulsing = true
    try { for (const session of sessions) await api('remote-grant', { grantId: session.grantId, ownerId: session.ownerId, slotName: session.slotName,
      tools, generation: 1, expiresAtMs: session.expiresAtMs, leaseExpiresAtMs: Math.min(session.expiresAtMs, Date.now() + 5000) }) }
    finally { pulsing = false }
  }
  const disabledModel = async () => { report.modelCallsAttempted++; throw Error('ALL_MODEL_CALLS_DISABLED_DURING_RECOVERY') }
  try {
    manager = await createAgentManager({ rootDirectory: root, runtimeDirectory: runtime,
      slotModelProviders: Object.fromEntries(comparisonOwners.map(value => [value.slotName, { kind: value.kind, model: original.models[value.slotName].model }])),
      planner: disabledModel, intentModelCall: disabledModel,
      playWorld: world.playWorld, playSpawn: world.playSpawn, movementBounds: world.taskBounds, taskRegions: world.taskRegions,
      authorizeRemote: async request => {
        const session = sessions.find(value => value.ownerId === request.ownerId && value.ownerName === request.ownerName && value.slotName === request.agentId)
        assert(session && request.plotId === session.slotName && request.grant === session.grantId && request.session === session.session && tools.includes(request.tool), 'Original controlled authority is required.')
        await pulse()
        return { principalId: session.ownerId, ownerPlayerId: session.ownerId, ownerName: session.ownerName, slotName: session.slotName,
          plotId: session.slotName, grantId: session.grantId, tools, generation: 1, expiresAtMs: session.expiresAtMs }
      },
      onTaskLock: async (slot, task, state) => {
        assert.equal(slot.ownerId, owner.ownerId); assert.equal(slot.name, owner.slotName)
        const originalTask = manager.tools.state.tasks.find(value => value.operationId === bench.operationId + ':step:0')
        const inspection = manager.tools.state.inspections?.[owner.ownerId]
        assert(task.id === originalTask.id || originalTask.status === 'complete' && task.id === inspection?.id, 'Only the original task or its final inspection may acquire a lock.')
        if (state.locked) await pulse()
        return api('task-lock', { slotName: slot.name, ownerId: slot.ownerId, ownerPlayerId: slot.minecraftPlayerId || slot.ownerId,
          taskId: task.id, locked: state.locked, remoteGrantId: owner.grantId, tool: task.plan?.action || 'inspect' })
      },
      onTaskResult: async (ownerId, message) => { report.notices.push({ ownerId, message: String(message), at: new Date().toISOString() }) }
    })
    manager.intents.requestModel = disabledModel
    const slot = manager.slots.find(value => value.ownerId === owner.ownerId && value.name === owner.slotName)
    const task = manager.tools.state.tasks.find(value => value.operationId === bench.operationId + ':step:0')
    const workflow = manager.intents.workflow(owner.ownerId)
    assert(slot); validateRecoveryTask(bench, workflow, task, owner)
    const originalTermsHash = hash(JSON.stringify(workflow.steps)), retainedReceipts = structuredClone(task.receipts)
    report.taskBefore = taskSummary(task)
    await pulse()
    timer = setInterval(() => { pulse().catch(error => { backgroundError = error }) }, 1000)
    for (const session of sessions) {
      const bound = manager.slots.find(value => value.ownerId === session.ownerId && value.name === session.slotName)
      assert(bound, 'Never replace or reassign an occupied slot.')
      await manager.ensureBot(bound)
    }
    await sleep(500)
    const bot = manager.getBot(owner.ownerId)
    report.before = { inventory: inventory(bot), cells: cells(bot, region, [0, 0, 4], [4, 3, 2]) }
    await save(output, report)
    await manager.intents.resume(owner.ownerId)
    manager.runWorkflow(slot, undefined, { grant: owner.grantId, session: owner.session })
    const until = Date.now() + 600000
    let lastCompleted = -1
    while (workflow.status === 'running' && Date.now() < until) {
      if (backgroundError) throw backgroundError
      if (task.completed.length !== lastCompleted) { lastCompleted = task.completed.length; console.log('Original bench recovery: ' + lastCompleted + '/14 placements reconciled.') }
      await sleep(250)
    }
    if (workflow.status === 'running') { manager.stop(slot); await manager.intents.pause(owner.ownerId, 'Recovery deadline reached; original pending effects retained.'); throw Error('RECOVERY_NATIVE_TIMEOUT_PRESERVE_RECEIPTS') }
    report.taskAfter = taskSummary(task)
    assert.equal(workflow.status, 'complete', workflow.message); assert.equal(task.status, 'complete', task.message); assert.equal(task.pending, null)
    assert.equal(hash(JSON.stringify(workflow.steps)), originalTermsHash, 'Immutable model-generated terms changed.')
    for (const [id, receipt] of Object.entries(retainedReceipts)) assert.deepEqual(task.receipts[id], receipt, 'A retained receipt changed.')
    const message = await manager.handleRemote({ operationId: randomUUID(), ownerId: owner.ownerId, ownerName: owner.ownerName,
      action: 'agent_inspect', args: '', grant: owner.grantId, session: owner.session })
    const inspection = slot.lastInspection
    assert(inspection && !/failed|refused/i.test(message), 'Final actual protected supplies inspection failed.')
    report.after = { inventory: inspection.inventory, source: inspection.source, destination: inspection.destination, cells: cells(bot, region, [0, 0, 4], [4, 3, 2]) }
    const placementReceipts = Object.keys(task.receipts).filter(id => id.startsWith(task.operationId + ':place:')).length
    report.checks = scoreBench(report.after.cells, bench.before.source.oak_planks - inspection.source.oak_planks, placementReceipts)
    report.checks.inventoryEmpty = !Object.values(inspection.inventory).some(Boolean)
    report.checks.oakConserved = inspection.source.oak_planks + (inspection.inventory.oak_planks || 0) + Object.values(report.after.cells).filter(name => name === 'oak_planks').length === bench.before.source.oak_planks
    report.checks.originalReceiptsRetained = Object.keys(retainedReceipts).every(id => JSON.stringify(retainedReceipts[id]) === JSON.stringify(task.receipts[id]))
    report.checks.originalArchPreserved = Object.values(scoreArch(cells(bot, region, [0, 0, 0], [3, 3, 1]), 7, 7)).every(Boolean)
    report.checks.noModelsCalled = report.modelCallsAttempted === 0
    assert(Object.values(report.checks).every(Boolean), 'Recovered native result did not satisfy its original constraints/accounting.')
    report.status = 'complete'; report.completedAt = new Date().toISOString()
  } catch (error) {
    report.status = 'failed'; report.error = error.message
    const slot = manager?.slots.find(value => value.ownerId === owner.ownerId)
    if (slot) { manager.stop(slot); await manager.intents.pause(owner.ownerId, 'Recovery stopped; retain original work and pending effects.') }
    if (manager) report.taskAfter = taskSummary(manager.tools.state.tasks.find(value => value.operationId === bench.operationId + ':step:0'))
  }
  try {
    assert.equal(hash(await readFile(originalFile)), originalHash, 'Original comparison report changed.')
    report.checks ??= {}
    report.checks.originalReportUnchanged = true
    for (const [slot, config] of Object.entries(settings)) assert.equal(hash(await readFile(config.budgetFile)), budgetHashes[slot], 'A model budget changed during inference-disabled recovery.')
    report.checks.budgetsUnchanged = true
    await save(output, report)
    console.log(JSON.stringify({ recoveryReport: output, status: report.status, checks: report.checks, error: report.error || null }))
    if (args.includes('--serve') && manager) {
      console.log('Both comparison agents remain connected; all model calls remain disabled. Stop before starting another manager.')
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
  } finally {
    clearInterval(timer)
    await manager?.close()
  }
  if (report.status !== 'complete') process.exitCode = 1
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
