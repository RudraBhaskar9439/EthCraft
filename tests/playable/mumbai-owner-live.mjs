// Explicit paid live check: real approved Micro, one bounded inference request per provider.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { loadZeroGProvider } from '../../backend/src/inference/zero-g.mjs'
import { loadAgentModelProvider } from '../../backend/src/inference/anthropic.mjs'
import { openDiscordIdentityRuntime } from '../../backend/src/discord/runtime.mjs'
import { approvedMumbaiOwner, createMumbaiAgentService, mumbaiAgentSlots } from '../../scripts/mumbai_agents.mjs'
import { sanitizedUsageReceipt } from '../../scripts/compare_agents.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const microPlayerId = '2bdce274-4975-3198-a0a1-740f0286f6bd'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const count = (items, name) => Number(items?.[name] || 0)
const total = items => Object.values(items || {}).reduce((sum, value) => sum + Number(value), 0)
const prompt = 'Build one flat 3 by 3 oak_planks platform in my registered plot, exactly nine blocks at the normal starting origin. Use the supported platform tool and do nothing else.'
const budgetView = state => ({ limitUsd: state.limitNanoUsd / 1e9, knownTokenCostEstimateUsd: state.spentNanoUsd / 1e9,
  completedRequests: state.completedRequests, pendingReservationCount: Object.keys(state.pending).length,
  reservedUnknownChargeUsd: Object.values(state.pending).reduce((sum, value) => sum + value.ceilingNanoUsd, 0) / 1e9,
  pendingSha256: hash(JSON.stringify(state.pending)), lastReceipt: sanitizedUsageReceipt(state.lastReceipt) })
const taskView = task => ({ id: task.id, operationId: task.operationId, status: task.status, plan: task.plan, completed: task.completed,
  pending: task.pending, receipts: Object.fromEntries(Object.entries(task.receipts).map(([id, receipt]) => [id, { before: receipt.before, after: receipt.after, observedAt: receipt.observedAt }])) })

function cells(bot, region) {
  const Vec = bot.entity.position.constructor, observed = {}
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    const position = [region.origin[0] + x, region.origin[1], region.origin[2] + z]
    const block = bot.blockAt(new Vec(...position))
    assert(block, 'MUMBAI_PLATFORM_CELL_UNOBSERVED')
    observed[[x, 0, z].join(',')] = block.name
  }
  return observed
}

async function run() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.log('Usage: node tests/playable/mumbai-owner-live.mjs --run')
    console.log('Stop the official Mumbai agent worker first. Micro must remain genuinely Discord-approved online. At most one paid planning request per provider; no retries, stock replenishment or target clearing.')
    return
  }
  const runId = randomUUID(), directory = join(root, 'evidence/runs/mumbai-owner-live', runId), privateDirectory = join(root, '.local/mumbai/owner-live', runId)
  await mkdir(directory, { recursive: true }); await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
  const reportFile = join(directory, 'report.json')
  const report = { schema: 'agentcity.mumbai-owner-live.v1', runId, startedAt: new Date().toISOString(), status: 'running',
    scope: 'Real approved local Micro and two hosted planners executing separate nine-block native tasks. No wallet actions, independent-human claim or production phase qualification.',
    maximumPaidRequests: 2, prompt, trials: [], modelCalls: 0, publicTransactions: 0,
    legacyPhysicalBuildReobservation: 'Unrun: no legacy bot connected and no arbitrary block-read endpoint added. Native namespace/world preservation is qualified separately.' }
  const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  let service, identity, pool, runtime, providers, legacyBefore, budgetBefore
  const legacyFiles = ['personal-agents.json', 'personal-agent-tasks.json', 'agent-conversations.json']
  try {
    const active = await json(join(root, '.local/playable-world/active.json'))
    assert(active.owner === 'agentcity-playable-pilot' && /^agentcity-playable-[a-f0-9]{8}$/.test(active.container), 'OWNED_PLAYABLE_WORLD_REQUIRED')
    runtime = join(root, '.local/playable-world', active.container)
    assert.equal(resolve(active.runtime), resolve(runtime), 'OWNED_PLAYABLE_RUNTIME_REQUIRED')
    const token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
    const api = async (path, body) => {
      const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw Error('MUMBAI_NATIVE_HTTP_' + response.status)
      return response.json()
    }
    const world = await api('status'), current = await api('session?playerId=' + microPlayerId)
    assert.equal(current.playerName, 'Micro', 'ACTUAL_MICRO_SESSION_REQUIRED')
    assert.equal(current.authenticationKind, 'discord_approved_local_profile', 'ACTUAL_DISCORD_APPROVAL_REQUIRED')
    const environment = await json(join(root, '.local/backend/environment.json'))
    pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 3 })
    identity = await openDiscordIdentityRuntime({ rootDirectory: root, pool, pluginApi: api })
    const base = { playerId: microPlayerId, connectionId: current.connectionId, createdAtMs: Date.now(), action: 'agent' }
    const owner = await approvedMumbaiOwner({ identity: identity.service, api, serverId: active.serverId }, base)
    report.identity = { playerName: current.playerName, actualApprovedConnection: true, canonicalPrincipalSha256: hash(owner.playerId), syntheticIdentityCreated: false }
    legacyBefore = Object.fromEntries(await Promise.all(legacyFiles.map(async file => [file, hash(await readFile(join(runtime, file)))])))
    for (const provider of Object.keys(mumbaiAgentSlots)) {
      const child = join(runtime, 'mumbai-' + provider)
      let tasks = { tasks: [] }, conversation = { owners: {} }
      try { tasks = await json(join(child, 'personal-agent-tasks.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { conversation = await json(join(child, 'agent-conversations.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      assert.equal(tasks.tasks.length, 0, 'MUMBAI_LIVE_REQUIRES_FRESH_TASKS')
      assert(Object.values(conversation.owners).every(owner => !owner.workflow && !owner.messages?.length), 'MUMBAI_LIVE_REQUIRES_FRESH_MODEL_HISTORY')
    }
    const configuration = await json(join(root, '.local/comparison/providers.json'))
    providers = { '0g': await loadZeroGProvider(root, configuration.CityAgent2), claude: await loadAgentModelProvider(root, configuration.CityAgent3) }
    budgetBefore = Object.fromEntries(await Promise.all(Object.entries(providers).map(async ([name, provider]) => [name, await json(provider.budget.file)])))
    await writeFile(join(privateDirectory, 'budgets-before.json'), JSON.stringify(budgetBefore, null, 2) + '\n', { mode: 0o600 })
    report.budgetsBefore = Object.fromEntries(Object.entries(budgetBefore).map(([name, state]) => [name, budgetView(state)]))
    service = await createMumbaiAgentService({ rootDirectory: root, runtimeDirectory: runtime, world, providers, identity: identity.service, api, serverId: active.serverId })
    await service.createForApprovedPlayer(microPlayerId)
    const inspect = async provider => {
      const manager = service.managers[provider], slot = manager.slots.find(slot => slot.ownerId === owner.playerId)
      const response = await service.handle({ ...base, operationId: randomUUID(), args: [provider, 'inspect'] })
      assert(slot.lastInspection && !/failed|refused|unavailable/i.test(response), 'MUMBAI_FRESH_NATIVE_INSPECTION_REQUIRED')
      return structuredClone(slot.lastInspection)
    }
    const before = {}
    for (const [provider, slotName] of Object.entries(mumbaiAgentSlots)) {
      const manager = service.managers[provider], slot = manager.slots.find(slot => slot.name === slotName)
      assert(slot && slot.ownerId === owner.playerId && slot.minecraftPlayerId === microPlayerId, 'ACTUAL_MICRO_AGENT_BINDING_REQUIRED')
      assert.equal(manager.tools.state.tasks.length, 0, 'MUMBAI_LIVE_REQUIRES_FRESH_TASKS')
      assert.equal(manager.intents.owner(owner.playerId).messages.length, 0, 'MUMBAI_LIVE_REQUIRES_FRESH_MODEL_HISTORY')
      assert.equal(manager.intents.workflow(owner.playerId), null, 'MUMBAI_LIVE_REQUIRES_FRESH_WORKFLOW')
      before[provider] = await inspect(provider)
      assert.equal(total(before[provider].inventory), 0, 'MUMBAI_LIVE_REQUIRES_EMPTY_AGENT_INVENTORY')
      assert(count(before[provider].source, 'oak_planks') >= 9, 'MUMBAI_NINE_REAL_SOURCE_PLANKS_REQUIRED')
      const region = world.taskRegions.find(region => region.slotName === slotName)
      assert(Object.values(cells(slot.bot, region)).every(name => ['air', 'cave_air', 'void_air'].includes(name)), 'MUMBAI_PLATFORM_TARGET_OCCUPIED_PRESERVE_IT')
    }
    await save()
    for (const [provider, slotName] of Object.entries(mumbaiAgentSlots)) {
      const manager = service.managers[provider], slot = manager.slots.find(slot => slot.name === slotName), region = world.taskRegions.find(region => region.slotName === slotName)
      const trial = { provider, model: providers[provider].model, slotName, operationId: randomUUID(), before: before[provider], modelRequests: 0, status: 'running' }
      report.trials.push(trial)
      const originalRequest = manager.intents.requestModel.bind(manager.intents), originalInterpret = manager.intents.interpret.bind(manager.intents)
      manager.intents.requestModel = async (...args) => {
        if (trial.modelRequests >= 1) { trial.additionalModelRequestRefused = true; throw Error('MUMBAI_ONE_REQUEST_PER_PROVIDER_LIMIT') }
        trial.modelRequests++; report.modelCalls++; await save()
        return originalRequest(...args)
      }
      manager.intents.interpret = async input => {
        const proposal = await originalInterpret(input)
        trial.proposal = structuredClone(proposal)
        assert(proposal.kind === 'plan' && proposal.steps.length === 1 && proposal.steps[0].action === 'build_platform' && proposal.steps[0].width === 3 && proposal.steps[0].depth === 3 && proposal.steps[0].material === 'oak_planks', 'MODEL_DID_NOT_PROPOSE_REQUESTED_NINE_BLOCK_PLATFORM')
        return proposal
      }
      try {
        const started = Date.now()
        trial.response = await service.handle({ ...base, operationId: trial.operationId, args: [provider, 'task', prompt] })
        let workflow = manager.intents.workflow(owner.playerId)
        assert.equal(workflow?.id, trial.operationId, 'MUMBAI_CURRENT_MODEL_WORKFLOW_REQUIRED')
        const deadline = Date.now() + 120000
        while (workflow.status === 'running' && Date.now() < deadline) { await delay(200); workflow = manager.intents.workflow(owner.playerId) }
        trial.elapsedMs = Date.now() - started
        assert.equal(workflow.status, 'complete', 'MUMBAI_NATIVE_PLATFORM_NOT_COMPLETE_PRESERVE_RECEIPTS')
        trial.after = await inspect(provider)
        trial.cells = cells(slot.bot, region)
        const tasks = manager.tools.state.tasks.filter(task => task.operationId?.startsWith(trial.operationId + ':'))
        trial.checks = {
          exactlyNineObservedOakBlocks: Object.values(trial.cells).length === 9 && Object.values(trial.cells).every(name => name === 'oak_planks'),
          sourceDecreasedByNine: count(trial.before.source, 'oak_planks') - count(trial.after.source, 'oak_planks') === 9,
          sourceOtherItemsUnchanged: Object.keys({ ...trial.before.source, ...trial.after.source }).filter(name => name !== 'oak_planks').every(name => count(trial.before.source, name) === count(trial.after.source, name)),
          carriedInventoryConserved: total(trial.before.inventory) === 0 && total(trial.after.inventory) === 0,
          destinationUnchanged: JSON.stringify(trial.before.destination) === JSON.stringify(trial.after.destination),
          allNativeTasksReconciled: tasks.length === 1 && tasks.every(task => task.status === 'complete' && task.pending === null),
          ninePlacementReceipts: tasks.reduce((sum, task) => sum + Object.keys(task.receipts).filter(id => id.startsWith(task.operationId + ':place:')).length, 0) === 9,
          oneHostedRequest: trial.modelRequests === 1
        }
        assert(Object.values(trial.checks).every(Boolean), 'MUMBAI_OBSERVED_BLOCK_OR_MATERIAL_ACCOUNTING_FAILED')
        trial.status = 'pass'
      } catch (error) {
        trial.status = 'fail'; trial.error = /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'MUMBAI_MODEL_OR_NATIVE_CHECK_FAILED'
        manager.stop(slot, 'Live verification stopped; retain work and receipts.')
        if (manager.intents.workflow(owner.playerId)?.status === 'running') await manager.intents.pause(owner.playerId, 'Live verification stopped; retain work and receipts.')
      }
      trial.tasks = manager.tools.state.tasks.filter(task => task.operationId?.startsWith(trial.operationId + ':')).map(taskView)
      trial.budgetAfter = budgetView(await json(providers[provider].budget.file))
      trial.knownApiCostUsd = trial.budgetAfter.knownTokenCostEstimateUsd - report.budgetsBefore[provider].knownTokenCostEstimateUsd
      await save()
      console.log(JSON.stringify({ provider, status: trial.status, modelRequests: trial.modelRequests, knownApiCostUsd: trial.knownApiCostUsd }))
    }
    report.status = report.trials.length === 2 && report.trials.every(trial => trial.status === 'pass') ? 'pass' : 'partial'
  } catch (error) {
    report.status = 'fail'; report.error = /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'MUMBAI_LIVE_PREFLIGHT_FAILED'
    process.exitCode = 1
  } finally {
    for (const close of [() => service?.close(), () => identity?.close(), () => pool?.end()]) {
      try { await close() } catch { report.cleanupFailed = true; report.status = 'fail'; process.exitCode = 1 }
    }
    for (const trial of report.trials) trial.tasks = service.managers[trial.provider].tools.state.tasks.filter(task => task.operationId?.startsWith(trial.operationId + ':')).map(taskView)
    if (runtime && legacyBefore) {
      const after = Object.fromEntries(await Promise.all(legacyFiles.map(async file => [file, hash(await readFile(join(runtime, file)))])))
      report.legacyFilesBefore = legacyBefore; report.legacyFilesAfter = after; report.legacyFilesUnchanged = JSON.stringify(after) === JSON.stringify(legacyBefore)
      if (!report.legacyFilesUnchanged) { report.status = 'fail'; report.preservationError = 'LEGACY_AGENT_FILES_CHANGED'; process.exitCode = 1 }
    }
    if (providers && budgetBefore) {
      const after = Object.fromEntries(await Promise.all(Object.entries(providers).map(async ([name, provider]) => [name, await json(provider.budget.file)])))
      await writeFile(join(privateDirectory, 'budgets-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 })
      report.budgetsAfter = Object.fromEntries(Object.entries(after).map(([name, state]) => [name, budgetView(state)]))
      report.existingZeroGReservationsUnchanged = Object.entries(budgetBefore['0g'].pending).every(([id, value]) => JSON.stringify(after['0g'].pending[id]) === JSON.stringify(value))
      if (!report.existingZeroGReservationsUnchanged || report.modelCalls > 2) { report.status = 'fail'; report.preservationError = 'MODEL_BUDGET_RESERVATION_OR_REQUEST_BOUND_CHANGED'; process.exitCode = 1 }
    }
    report.sourceHashes = Object.fromEntries(await Promise.all(['tests/playable/mumbai-owner-live.mjs', 'scripts/mumbai_agents.mjs', 'backend/src/playable/agents.mjs'].map(async file => [file, hash(await readFile(join(root, file)))])))
    report.finishedAt = new Date().toISOString(); await save()
    if (report.status !== 'pass') process.exitCode = 1
    console.log(JSON.stringify({ status: report.status, modelCalls: report.modelCalls, evidence: reportFile }))
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) run().catch(() => { console.error('MUMBAI_LIVE_CHECK_FAILED_RETAIN_EVIDENCE'); process.exitCode = 1 })
