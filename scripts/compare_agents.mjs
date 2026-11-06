import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentManager } from '../backend/src/playable/agents.mjs'
import { loadAgentModelProvider } from '../backend/src/inference/anthropic.mjs'
import { loadZeroGProvider } from '../backend/src/inference/zero-g.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const air = name => ['air', 'cave_air', 'void_air'].includes(name)
const count = (items, item) => Number(items?.[item] || 0)
const total = items => Object.values(items || {}).reduce((sum, n) => sum + Number(n), 0)
function offlineUuid(name) {
  const bytes = createHash('md5').update('OfflinePlayer:' + name).digest()
  bytes[6] = bytes[6] & 15 | 48; bytes[8] = bytes[8] & 63 | 128
  const value = bytes.toString('hex')
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-')
}
export const comparisonOwners = Object.freeze([
  { slotName: 'CityAgent2', ownerName: 'Compare0G', ownerId: offlineUuid('Compare0G'), kind: '0g' },
  { slotName: 'CityAgent3', ownerName: 'CompareClaude', ownerId: offlineUuid('CompareClaude'), kind: 'anthropic' }
])
export const comparisonTrials = Object.freeze([
  { id: 'delivery', prompt: 'Inspect my actual supplies, deliver exactly six cobblestone from my registered source chest to my registered destination chest, then inspect supplies again. Do nothing else.' },
  { id: 'arch', prompt: 'Build one cobblestone arch at relative offset [0,0,0] in my own plot. It must be exactly three blocks wide, one block deep and three blocks high: two full-height end pillars and a top connecting block. Keep the two central cells below the top open. Use exactly seven cobblestone. Do nothing else.' },
  { id: 'bench', prompt: 'Build an original oak_planks bench at relative offset [0,0,4] in my own plot, bounded by four blocks wide, two blocks deep and three blocks high, using at most fourteen blocks. Include a four-block-wide raised seat at relative y=1 and z=0, end legs at x=0 and x=3 in both depth rows at y=0, two back posts at x=0 and x=3 at y=1,z=1, and a full-width top rail at y=2,z=1. Keep the two middle back cells at y=1,z=1 open. Use a custom blueprint, not a named house, wall or platform. Do nothing else.' }
])

export function scoreDelivery(before, after) {
  return {
    sourceDecreasedBySix: count(before.source, 'cobblestone') - count(after.source, 'cobblestone') === 6,
    destinationIncreasedBySix: count(after.destination, 'cobblestone') - count(before.destination, 'cobblestone') === 6,
    inventoryConserved: count(before.inventory, 'cobblestone') === count(after.inventory, 'cobblestone'),
    oakUnchanged: count(before.source, 'oak_planks') === count(after.source, 'oak_planks')
  }
}
export function scoreArch(cells, consumed, placements) {
  const at = (x, y, z) => cells[[x, y, z].join(',')]
  const required = [0, 2].flatMap(x => [0, 1, 2].map(y => [x, y, 0])).concat([[1, 2, 0]])
  return { sevenExpectedBlocks: required.every(p => at(...p) === 'cobblestone'),
    centralOpeningClear: [0, 1].every(y => air(at(1, y, 0))),
    exactlySevenMaterials: consumed === 7, exactlySevenPlacements: placements === 7 }
}
export function scoreBench(cells, consumed, placements) {
  const at = (x, y, z) => cells[[x, y, z].join(',')]
  return {
    raisedSeat: [0, 1, 2, 3].every(x => at(x, 1, 0) === 'oak_planks'),
    endLegs: [0, 3].every(x => [0, 1].every(z => at(x, 0, z) === 'oak_planks')),
    backPosts: [0, 3].every(x => at(x, 1, 1) === 'oak_planks'),
    topRail: [0, 1, 2, 3].every(x => at(x, 2, 1) === 'oak_planks'),
    openBack: [1, 2].every(x => air(at(x, 1, 1))),
    boundedMaterialUse: consumed > 0 && consumed <= 14 && consumed === placements
  }
}
export function requireCurrentWorkflow(operationId, workflow, cause) {
  if (workflow?.id !== operationId) throw Error('COMPARISON_PLANNING_FAILED: ' + (cause || 'No workflow was created for this request.'))
  return workflow
}

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
}
export function sanitizedUsageReceipt(receipt) {
  if (!receipt) return null
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
  return { ...pick(receipt, ['model', 'responseId', 'requestId', 'requestSha256', 'costNanoUsd', 'latencyMs', 'recordedAt']),
    usage: pick(receipt.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']),
    ...(receipt.pricing ? { pricing: pick(receipt.pricing, ['model', 'inputNanoUsd', 'outputNanoUsd', 'contextTokens', 'source', 'observedAt']) } : {}) }
}
async function usage(provider) {
  const ledger = await json(provider.budget.file)
  return { spentUsd: ledger.spentNanoUsd / 1e9, completedRequests: ledger.completedRequests,
    pendingReservations: Object.keys(ledger.pending), blockedReason: ledger.blockedReason || null,
    lastReceipt: sanitizedUsageReceipt(ledger.lastReceipt) }
}
function scan(bot, region, offset, size) {
  const Vec = bot.entity.position.constructor, cells = {}
  for (let x = 0; x < size[0]; x++) for (let y = 0; y < size[1]; y++) for (let z = 0; z < size[2]; z++) {
    const position = region.origin.map((n, i) => n + offset[i] + [x, y, z][i])
    const block = bot.blockAt(new Vec(...position))
    if (!block) throw Error('COMPARISON_WORLD_CELL_UNOBSERVED')
    cells[[x, y, z].join(',')] = block.name
  }
  return cells
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.includes('--run')) {
    console.log('Usage: node scripts/compare_agents.mjs --run [--serve] [--providers /absolute/providers.json]')
    console.log('Requires explicit paid-call authorization, fresh free slots CityAgent2/3 and the normal worker stopped. --serve keeps the two agents online after the bounded comparison.')
    return
  }
  const providersFlag = args.indexOf('--providers')
  const settingsFile = providersFlag < 0 ? join(root, '.local/comparison/providers.json') : resolve(args[providersFlag + 1])
  const settings = await json(settingsFile)
  const active = await json(join(root, '.local/playable-world/active.json'))
  assert.equal(active.owner, 'agentcity-playable-pilot')
  assert.match(active.container, /^agentcity-playable-[a-f0-9]{8}$/)
  const runtime = join(root, '.local/playable-world', active.container)
  const beforeAgents = await json(join(runtime, 'personal-agents.json'))
  assert(beforeAgents.agents.some(slot => slot.name === 'CityAgent1'), 'Preserve the existing first agent; never allocate the comparison over it.')
  for (const owner of comparisonOwners) assert(!beforeAgents.agents.some(slot => slot.name === owner.slotName || slot.ownerId === owner.ownerId), 'Comparison needs fresh unoccupied slots; preserve any existing or interrupted work.')
  const token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
  const api = async (suffix, body) => {
    const response = await fetch('http://127.0.0.1:25597/playable/' + suffix, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw Error('COMPARISON_NATIVE_' + suffix.split('?')[0] + '_HTTP_' + response.status)
    return response.json()
  }
  const world = await api('status')
  assert.equal(world.playWorld, 'agentcity_play')
  const slotModelProviders = {}
  for (const owner of comparisonOwners) {
    assert.equal(settings[owner.slotName]?.provider, owner.kind)
    assert.equal(settings[owner.slotName].maxTokens, 1536, 'Both providers must use the same bounded output allowance.')
    slotModelProviders[owner.slotName] = await (owner.kind === '0g' ? loadZeroGProvider : loadAgentModelProvider)(root, settings[owner.slotName])
  }
  const runId = randomUUID(), directory = join(root, '.local/comparison/runs', runId), reportFile = join(directory, 'report.json')
  const grants = comparisonOwners.map(owner => ({ ...owner, grantId: randomUUID(), session: randomUUID(), expiresAtMs: Date.now() + 8 * 3600000 }))
  const tools = ['status', 'inspect', 'wait', 'build', 'deliver']
  const report = { version: 1, runId, startedAt: new Date().toISOString(), status: 'running',
    disclosure: 'Two operator-controlled owner fixtures, not independent humans or Discord/Privy identity proofs. Actual hosted model proposals and native Minecraft effects. No blockchain or marketplace actions.',
    world: world.playWorld, models: Object.fromEntries(comparisonOwners.map(owner => [owner.slotName, { provider: owner.kind, model: slotModelProviders[owner.slotName].model }])),
    maxOutputTokens: 1536, trials: [], planning: [], notices: [], budgetsBefore: {}, budgetsAfter: {} }
  report.usageEvidence = 'Each checkpoint preserves the latest sanitized provider receipt, completed request count and aggregate cost. A trial can include multiple calls for geometry or repair; intermediate receipts within that trial are not all retained.'
  await save(join(directory, 'controlled-sessions.json'), grants)
  for (const owner of comparisonOwners) report.budgetsBefore[owner.slotName] = await usage(slotModelProviders[owner.slotName])
  let manager, pulseTimer, pulsing = false, backgroundError
  const pulse = async () => {
    if (pulsing) return
    pulsing = true
    try { for (const grant of grants) await api('remote-grant', { grantId: grant.grantId, ownerId: grant.ownerId, slotName: grant.slotName,
      tools, generation: 1, expiresAtMs: grant.expiresAtMs, leaseExpiresAtMs: Math.min(grant.expiresAtMs, Date.now() + 5000) }) }
    finally { pulsing = false }
  }
  const remote = (owner, action, args = '') => ({ operationId: randomUUID(), ownerId: owner.ownerId, ownerName: owner.ownerName,
    action, args, grant: owner.grantId, session: owner.session })
  const inspect = async owner => {
    const response = await manager.handleRemote(remote(owner, 'agent_inspect'))
    const snapshot = manager.slots.find(slot => slot.ownerId === owner.ownerId)?.lastInspection
    assert(snapshot && !/failed|refused/i.test(response), 'Actual protected supplies inspection must succeed: ' + response)
    return structuredClone(snapshot)
  }
  try {
    manager = await createAgentManager({ rootDirectory: root, runtimeDirectory: runtime, slotModelProviders,
      playWorld: world.playWorld, playSpawn: world.playSpawn, movementBounds: world.taskBounds, taskRegions: world.taskRegions,
      authorizeRemote: async request => {
        const grant = grants.find(value => value.ownerId === request.ownerId && value.ownerName === request.ownerName && value.slotName === request.agentId)
        if (!grant || request.plotId !== grant.slotName || request.grant !== grant.grantId || request.session !== grant.session || !tools.includes(request.tool)) throw Error('CONTROLLED_COMPARISON_AUTH_REFUSED')
        await pulse()
        return { principalId: grant.ownerId, ownerPlayerId: grant.ownerId, ownerName: grant.ownerName, slotName: grant.slotName,
          plotId: grant.slotName, grantId: grant.grantId, tools, generation: 1, expiresAtMs: grant.expiresAtMs }
      },
      onTaskLock: async (slot, task, state) => {
        const grant = grants.find(value => value.ownerId === slot.ownerId && value.slotName === slot.name)
        assert(grant, 'Comparison may not alter another owner task lock.')
        if (state.locked) await pulse()
        return api('task-lock', { slotName: slot.name, ownerId: slot.ownerId, ownerPlayerId: slot.minecraftPlayerId || slot.ownerId,
          taskId: task.id, locked: state.locked, remoteGrantId: grant.grantId, tool: task.plan?.action || 'inspect' })
      },
      onTaskResult: async (ownerId, message) => { report.notices.push({ ownerId, message: String(message), at: new Date().toISOString() }) }
    })
    const originalInterpret = manager.intents.interpret.bind(manager.intents)
    manager.intents.interpret = async input => {
      const start = performance.now(), entry = { ownerId: input.ownerId, text: input.text, context: structuredClone(input.context) }
      report.planning.push(entry)
      try { return entry.proposal = await originalInterpret(input) }
      catch (error) { entry.error = error.message; throw error }
      finally { entry.latencyMs = Math.round(performance.now() - start); await save(reportFile, report) }
    }
    pulseTimer = setInterval(() => { pulse().catch(error => { backgroundError = error }) }, 1000)
    for (const owner of grants) {
      const created = await manager.handleRemote(remote(owner, 'agent_create'))
      assert(created.includes(owner.slotName + ' is your personal agent'), created)
      const region = world.taskRegions.find(value => value.slotName === owner.slotName)
      assert(region)
      const bot = manager.getBot(owner.ownerId), supplies = await inspect(owner)
      assert.equal(count(supplies.source, 'oak_planks'), 128, 'Never reset a previously used source chest.')
      assert.equal(count(supplies.source, 'cobblestone'), 64, 'Never reset a previously used source chest.')
      assert.equal(total(supplies.source), 192, 'Both source contexts must contain only the same disclosed fixture materials.')
      assert.equal(total(supplies.inventory), 0); assert.equal(total(supplies.destination), 0)
      assert(Object.values(scan(bot, region, [0, 0, 0], [3, 3, 1])).every(air), 'Arch footprint must be unused.')
      assert(Object.values(scan(bot, region, [0, 0, 4], [4, 3, 2])).every(air), 'Bench footprint must be unused.')
    }
    const blockedOwners = new Set()
    for (const trial of comparisonTrials) for (const owner of grants) {
      if (backgroundError) throw backgroundError
      if (blockedOwners.has(owner.ownerId)) {
        report.trials.push({ trial: trial.id, slotName: owner.slotName, status: 'blocked', passed: false,
          reason: 'Earlier failure requires reconciliation; no new model request or Minecraft task was attempted.' })
        continue
      }
      const result = { trial: trial.id, slotName: owner.slotName, ownerId: owner.ownerId, prompt: trial.prompt,
        startedAt: new Date().toISOString(), status: 'running' }
      report.trials.push(result)
      try {
        const provider = slotModelProviders[owner.slotName], beforeBudget = await usage(provider)
        assert(!beforeBudget.blockedReason && !beforeBudget.pendingReservations.length, 'Uncertain previous API charges must be reconciled before another request.')
        const before = await inspect(owner), request = remote(owner, 'agent_task', trial.prompt)
        Object.assign(result, { operationId: request.operationId, before, budgetBefore: beforeBudget })
        await save(reportFile, report)
        const start = performance.now()
        result.response = await manager.handleRemote(request)
        const until = Date.now() + 240000
        let workflow = manager.intents.workflow(owner.ownerId)
        if (workflow?.id !== request.operationId) {
          result.planningError = report.planning.findLast(entry => entry.ownerId === owner.ownerId && entry.text === trial.prompt)?.error || result.response
          result.priorWorkflow = workflow ? { id: workflow.id, status: workflow.status } : null
          result.budgetAfter = await usage(provider)
          result.apiCostUsd = result.budgetAfter.spentUsd - beforeBudget.spentUsd
          requireCurrentWorkflow(request.operationId, workflow, result.planningError)
        }
        while (workflow?.id === request.operationId && workflow.status === 'running' && Date.now() < until) {
          if (backgroundError) throw backgroundError
          await sleep(250); workflow = manager.intents.workflow(owner.ownerId)
        }
        result.durationMs = Math.round(performance.now() - start)
        result.workflow = structuredClone(workflow)
        result.tasks = structuredClone(manager.tools.state.tasks.filter(task => task.ownerId === owner.ownerId && task.operationId?.startsWith(request.operationId + ':')))
        result.budgetAfter = await usage(provider)
        result.apiCostUsd = result.budgetAfter.spentUsd - beforeBudget.spentUsd
        result.status = workflow?.id === request.operationId && workflow.status === 'complete' ? 'complete' : 'failed'
        if (workflow?.status === 'running') throw Error('COMPARISON_TASK_TIMEOUT_PRESERVE_FOR_RECONCILIATION')
        result.after = await inspect(owner)
        const region = world.taskRegions.find(value => value.slotName === owner.slotName), bot = manager.getBot(owner.ownerId)
        const placements = result.tasks.reduce((sum, task) => sum + (task.plan.placements?.length || 0), 0)
        if (trial.id === 'delivery') result.checks = scoreDelivery(before, result.after)
        if (trial.id === 'arch') {
          result.cells = scan(bot, region, [0, 0, 0], [3, 3, 1])
          result.checks = scoreArch(result.cells, count(before.source, 'cobblestone') - count(result.after.source, 'cobblestone'), placements)
        }
        if (trial.id === 'bench') {
          result.cells = scan(bot, region, [0, 0, 4], [4, 3, 2])
          result.checks = scoreBench(result.cells, count(before.source, 'oak_planks') - count(result.after.source, 'oak_planks'), placements)
        }
        result.checks.nativeTasksReconciled = result.tasks.every(task => task.status === 'complete' && !task.pending)
        result.checks.receivingReceiptsPresent = result.tasks.length > 0 && result.tasks.every(task => Object.keys(task.receipts || {}).length > 0)
        if (trial.id !== 'delivery') result.checks.nativePlacementReceipts = result.tasks.reduce((sum, task) => sum + Object.keys(task.receipts || {}).filter(id => id.startsWith(task.operationId + ':place:')).length, 0) === placements
        result.passed = result.status === 'complete' && Object.values(result.checks).every(Boolean)
        await save(reportFile, report)
        console.log(JSON.stringify({ slot: owner.slotName, trial: trial.id, passed: result.passed, checks: result.checks, apiCostUsd: result.apiCostUsd }))
        if (!result.passed) throw Error('COMPARISON_CONSTRAINT_FAILED_PRESERVE_BUILD_AND_RECEIPTS')
      } catch (error) {
        result.status = 'failed'; result.passed = false; result.error = error.message
        blockedOwners.add(owner.ownerId)
        const slot = manager.slots.find(value => value.ownerId === owner.ownerId)
        if (slot) manager.stop(slot)
        await manager.intents.pause(owner.ownerId, 'Comparison stopped after failure; retain native receipts for reconciliation.')
        await save(reportFile, report)
        console.log(JSON.stringify({ slot: owner.slotName, trial: trial.id, passed: false, error: error.message }))
      }
    }
    report.status = report.trials.every(trial => trial.passed) ? 'complete' : 'partial'; report.completedAt = new Date().toISOString()
    report.conclusionLimit = 'Three bounded tasks compare these exact hosted models and current tools; they do not establish universal creative superiority.'
    for (const owner of comparisonOwners) report.budgetsAfter[owner.slotName] = await usage(slotModelProviders[owner.slotName])
    await save(reportFile, report)
    console.log('Comparison ' + report.status + ': ' + reportFile)
    if (args.includes('--serve')) {
      console.log('Both controlled comparison agents remain online. No further model requests run automatically. Stop with Ctrl+C before restarting the normal worker.')
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
  } catch (error) {
    report.status = 'failed'; report.error = error.message
    throw error
  } finally {
    clearInterval(pulseTimer)
    await manager?.close()
    for (const owner of comparisonOwners) report.budgetsAfter[owner.slotName] = await usage(slotModelProviders[owner.slotName])
    await save(reportFile, report)
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
