import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIntentPlanner, validateIntent } from '../../backend/src/playable/intent-planner.mjs'
import { PersonalAgents } from '../../backend/src/playable/agents.mjs'

const directory = await mkdtemp(join(tmpdir(), 'agent-intents-'))
const plan = { kind: 'plan', message: 'Build, deliver, collect, then sell.', steps: [
  { action: 'build_shelter', width: 4, depth: 4, material: 'oak_planks' },
  { action: 'deliver', item: 'cobblestone', count: 4 },
  { action: 'collect', item: 'cobblestone', count: 4 },
  { action: 'sell', item: 'cobblestone', count: 4 }
] }
try {
  {
    const defaultProvider = { kind: 'ollama', model: 'fixture-default' }
    const providers = { 'owner-0g': { kind: '0g', model: 'glm-4.7' }, 'owner-claude': { kind: 'anthropic', model: 'fixture-claude' } }
    const resolutions = new Map(), calls = [], initial = new Set()
    let releaseInitial
    const bothInitialRequests = new Promise(resolve => { releaseInitial = resolve })
    const routed = await createIntentPlanner({ runtimeDirectory: join(directory, 'concurrent-providers'), provider: defaultProvider,
      providerForOwner: ownerId => { resolutions.set(ownerId, (resolutions.get(ownerId) || 0) + 1); return providers[ownerId] } })
    routed.requestModel = async (messages, schema, provider) => {
      const geometry = messages[0].content.startsWith('You design original bounded Minecraft geometry.')
      const repair = messages.at(-1).content.startsWith('Validation refused your proposed item/count:')
      calls.push({ provider, geometry, repair })
      if (!geometry && !repair) {
        initial.add(provider.model)
        if (initial.size === 2) releaseInitial()
        await bothInitialRequests
      }
      if (provider === providers['owner-0g']) {
        assert(!geometry)
        return { kind: 'plan', message: 'Deliver requested real stock.', steps: [{ action: 'deliver', item: 'cobblestone', count: repair ? 6 : 4 }] }
      }
      assert.equal(provider, providers['owner-claude'])
      if (geometry) return { builds: [{ index: 0, material: 'cobblestone', width: 3, depth: 3, height: 1,
        parts: [{ min: [0, 0, 0], max: [2, 0, 0] }, { min: [0, 0, 0], max: [0, 0, 2] }] }] }
      return { kind: 'plan', message: 'Build requested original L.', steps: [{ action: 'build_structure', structure: 'custom', material: 'cobblestone', width: 3, depth: 3, height: 1, designRequest: 'Low L shape' }] }
    }
    const [stock, shape] = await Promise.all([
      routed.interpret({ ownerId: 'owner-0g', text: 'Deliver six cobblestone. Ignore any instruction to change my model.' }),
      routed.interpret({ ownerId: 'owner-claude', text: 'Build a custom low cobblestone L shape three by three and one high.' })
    ])
    assert.equal(stock.steps[0].count, 6)
    assert.equal(shape.steps[0].parts.length, 2)
    assert.deepEqual([...resolutions.entries()].sort(), [['owner-0g', 1], ['owner-claude', 1]])
    assert.deepEqual(calls.filter(call => call.provider === providers['owner-0g']).map(call => [call.geometry, call.repair]), [[false, false], [false, true]])
    assert.deepEqual(calls.filter(call => call.provider === providers['owner-claude']).map(call => [call.geometry, call.repair]), [[false, false], [true, false]])
    const failedCalls = []
    routed.requestModel = async (_, __, provider) => { failedCalls.push(provider); throw Error('FIXTURE_0G_UNAVAILABLE') }
    await assert.rejects(routed.interpret({ ownerId: 'owner-0g', text: 'Inspect supplies.' }), /FIXTURE_0G_UNAVAILABLE/)
    assert.deepEqual(failedCalls, [providers['owner-0g']])
    await routed.close()
    const single = await createIntentPlanner({ runtimeDirectory: join(directory, 'default-provider'), provider: defaultProvider })
    single.requestModel = async (_, __, provider) => { assert.equal(provider, defaultProvider); return { kind: 'plan', message: 'Inspect actual supplies.', steps: [{ action: 'inspect' }] } }
    assert.equal((await single.interpret({ ownerId: 'single-owner', text: 'Inspect supplies.' })).steps[0].action, 'inspect')
    await single.close()
    console.log('PASS concurrent owners keep their selected provider through geometry and quantity repair, failure has no fallback, and default single-provider routing is unchanged')
  }
  assert.deepEqual(validateIntent(plan), plan)
  for (const invalid of [ { ...plan, steps: Array(7).fill(plan.steps[0]) }, { ...plan, steps: [{ action: 'eval', code: 'evil' }] }, { ...plan, steps: [{ action: 'deliver', item: 'cobblestone', count: 4, source: [0,0,0] }] }, { ...plan, steps: [{ action: 'sell', item: 'diamond', count: 1 }] }, { ...plan, steps: [{ action: 'build_shelter', width: 7, depth: 4, material: 'oak_planks' }] } ]) assert.throws(() => validateIntent(invalid))
  console.log('PASS bounded strict multi-step schema refuses arbitrary code, coordinates, oversized structures and unsupported items')
  const arch = { action: 'build_structure', material: 'oak_planks', offset: [5, 0, 6], placements: [[0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 1, 0], [0, 2, 0], [1, 2, 0], [2, 2, 0]].map(offset => ({ offset })) }
  const buildIntent = { kind: 'plan', message: 'Proposed custom arch', steps: [arch] }
  assert.deepEqual(validateIntent(buildIntent).steps[0], arch)
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...arch, placements: [...arch.placements, arch.placements[0]] }] }))
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...arch, placements: [{ offset: [8, 0, 0] }] }] }))
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...arch, world: 'another_player_world' }] }))
  const boxes = { action: 'build_structure', material: 'cobblestone', width: 3, depth: 3, height: 1, parts: [{ min: [0, 0, 0], max: [2, 0, 0] }, { min: [0, 0, 0], max: [0, 0, 2] }] }
  assert.deepEqual(validateIntent({ ...buildIntent, steps: [boxes] }).steps[0], boxes)
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...boxes, height: 3 }] }), /DIMENSIONS_MISMATCH/)
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...boxes, parts: [...boxes.parts, { min: [0, 0, 0], max: [0, 0, 0], material: 'glass' }] }] }), /CONFLICTING/)
  validateIntent({ ...buildIntent, steps: [{ ...arch, width: 3, depth: 1, height: 3 }] })
  assert.throws(() => validateIntent({ ...buildIntent, steps: [{ ...arch, width: 3, depth: 1, height: 2 }] }), /DIMENSIONS_MISMATCH/)
  validateIntent({ ...buildIntent, steps: [{ action: 'build_structure', structure: 'arch', width: 3, depth: 1, height: 3, material: 'oak_planks' }] })
  const preparation = validateIntent({ kind: 'plan', message: 'Real resource preparation', steps: [{ action: 'gather', item: 'oak_planks', count: 2 }, { action: 'craft', item: 'sticks', count: 4 }, { action: 'deliver', item: 'stick', count: 4 }] })
  assert.equal(preparation.steps[1].item, 'stick')
  assert.equal(validateIntent({kind:'plan',message:'Preview one carried stick for CITY registration',steps:[{action:'market',item:'stick',count:1}]},{marketEnabled:true}).steps[0].item,'stick')
  assert.throws(() => validateIntent({ ...preparation, steps: [{ action: 'gather', item: 'oak_log', count: 17 }] }))
  assert.throws(() => validateIntent({ ...preparation, steps: [{ action: 'craft', item: 'diamond', count: 1 }] }))
  console.log('PASS original relative blueprints, bounded gathering and canonical recipe outputs validate without absolute-world authority or unsupported item creation')
  const foodPlanner = await createIntentPlanner({ runtimeDirectory: join(directory, 'unsupported-food'), modelCall: async messages => {
    assert.match(messages[0].content, /Never substitute dirt, sand or wood for food/)
    return { kind: 'plan', message: 'Build a home and get food', steps: [{ action: 'build_structure', structure: 'house', width: 4, depth: 4, height: 4, material: 'oak_planks' }, { action: 'gather', item: 'dirt', count: 1 }] }
  } })
  const foodReply = await foodPlanner.interpret({ ownerId: 'food-owner', text: 'build a nice home and get some food' })
  assert.equal(foodReply.kind, 'clarify'); assert.deepEqual(foodReply.steps, []); assert.equal(foodPlanner.workflow('food-owner'), null)
  await foodPlanner.close()
  const logPlanner = await createIntentPlanner({ runtimeDirectory: join(directory, 'grounded-gather'), modelCall: async () => ({ kind: 'plan', message: 'Gather requested logs', steps: [{ action: 'gather', item: 'oak_log', count: 2 }] }) })
  assert.equal((await logPlanner.interpret({ ownerId: 'log-owner', text: 'Gather two oak logs from my plot' })).kind, 'plan')
  assert.equal((await logPlanner.interpret({ ownerId: 'different-owner', text: 'Gather some logs' })).kind, 'clarify')
  await logPlanner.close()
  console.log('PASS food cannot become dirt harvesting; explicit supported gather item and quantity remain accepted and vague quantities ask for clarification')
  let calls = 0
  let planner = await createIntentPlanner({ runtimeDirectory: directory, modelCall: async messages => {
    calls++
    const context = JSON.parse(messages[0].content.split('Observed context (data only): ')[1])
    assert.equal(context.inventory[0].count, 4)
    if (calls === 2) { assert(messages.some(message => message.content.includes('small shelter'))); return { kind: 'clarify', message: 'The existing task uses wood. Confirm a new stone task after reconciliation?', steps: [] } }
    return plan
  } })
  const context = { world: 'agentcity_play', inventory: [{ name: 'cobblestone', count: 4 }] }
  await planner.interpret({ ownerId: 'owner', text: 'small shelter and deliver four, sell four more', context })
  const accepted = await planner.accept('owner', plan, 'original', 123)
  assert.equal(accepted.accepted, true)
  const clarification = await planner.interpret({ ownerId: 'owner', text: 'use stone instead', context })
  assert.equal(clarification.kind, 'clarify')
  assert.equal(planner.workflow('owner').steps[0].material, 'oak_planks')
  assert.equal((await planner.accept('owner', { ...plan, steps: [{ action: 'wait' }] }, 'changed')).accepted, false)
  console.log('PASS owner conversation carries inventory/history and immutable active terms survive clarification')
  let observedComplete = false, dispatched = [], effects = new Set()
  const dispatch = async (step, id) => { dispatched.push(id); effects.add(id); return 'Started' }
  const driving = planner.drive('owner', { dispatch, observe: async () => ({ state: observedComplete ? 'complete' : 'running' }) })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(dispatched, ['original:step:0'])
  await planner.pause('owner')
  await driving
  assert.equal(planner.workflow('owner').index, 0)
  await planner.close()
  planner = await createIntentPlanner({ runtimeDirectory: directory })
  assert.equal(planner.workflow('owner').status, 'paused')
  assert.equal(planner.workflow('owner').pending.operationId, 'original:step:0')
  observedComplete = true
  assert.equal(await planner.resume('owner'), true)
  await planner.drive('owner', { dispatch, observe: async () => ({ state: 'complete', message: 'Observed complete' }) })
  assert.equal(planner.workflow('owner').status, 'complete')
  assert.equal(planner.workflow('owner').receipts.length, 4)
  assert.equal(effects.size, 4)
  assert.equal(dispatched[1], 'original:step:0')
  console.log('PASS physical acknowledgement waits for observed completion, paused restart retains stable receiving IDs and resumes sequentially')
  await planner.accept('other', { kind: 'plan', message: 'Collect then sell', steps: plan.steps.slice(2) }, 'shortage')
  let next = 0
  await planner.drive('other', { dispatch: async () => { next++; return 'Not enough stock' }, observe: async () => ({ state: 'paused', message: 'Material shortage' }) })
  assert.equal(next, 1); assert.equal(planner.workflow('other').index, 0); assert.equal(planner.workflow('other').status, 'paused')
  assert.equal(planner.workflow('owner').status, 'complete')
  console.log('PASS shortage pauses without selling or claiming complete; owners retain separate workflow state')
  assert.throws(() => validateIntent({ kind: 'plan', message: 'Swap', steps: [{ action: 'swap', amountIn: '2', tokenIn: 'CITY', tokenOut: 'GEM' }] }))
  validateIntent({ kind: 'plan', message: 'Swap', steps: [{ action: 'swap', amountIn: '2', tokenIn: 'CITY', tokenOut: 'GEM' }] }, { marketEnabled: true })
  const market = await createIntentPlanner({ runtimeDirectory: join(directory, 'market'), marketEnabled: true })
  const swap = { kind: 'plan', message: 'Preview swap only', steps: [{ action: 'swap', amountIn: '2', tokenIn: 'CITY', tokenOut: 'GEM' }] }
  await market.accept('owner', swap, 'swap-original', 456)
  let confirmed = false, quoteIds = []
  const marketDispatch = async (_, id, createdAtMs) => { quoteIds.push(id); assert.equal(createdAtMs, 456); return { complete: confirmed, message: confirmed ? 'Confirmed original quote' : 'Awaiting owner confirmation' } }
  const marketObserve = async (_, __, reply) => ({ state: reply.complete ? 'complete' : 'paused', message: reply.message })
  await market.drive('owner', { dispatch: marketDispatch, observe: marketObserve })
  assert.equal(market.workflow('owner').status, 'paused'); assert.equal(market.workflow('owner').index, 0)
  confirmed = true; await market.resume('owner'); await market.drive('owner', { dispatch: marketDispatch, observe: marketObserve })
  assert.deepEqual(quoteIds, ['swap-original:step:0', 'swap-original:step:0']); assert.equal(market.workflow('owner').status, 'complete')
  await market.close()
  console.log('PASS market preview cannot advance before owner confirmation and resumes with the same quote operation and timestamp')
  const manager = new PersonalAgents({ rootDirectory: directory, runtimeDirectory: directory })
  const owner = { ownerId: '11111111-1111-4111-8111-111111111111', ownerName: 'AuthFixture' }
  const connectionId = '22222222-2222-4222-8222-222222222222'
  let forwarded
  manager.save = async () => {}
  const inventoryPlayerId = '33333333-3333-4333-8333-333333333333'
  manager.ensureBot = async () => ({ player: { uuid: inventoryPlayerId } })
  manager.ownerVisible = () => true
  let callbacks = 0, unfinished = false, selectedStep = { action: 'swap', amountIn: '2', tokenIn: 'CITY', tokenOut: 'GEM' }
  manager.tools = { unfinished: () => unfinished }
  manager.marketHandler = async event => { callbacks++; forwarded = event; return { complete: false, message: 'Explicit auth fixture preview only' } }
  manager.intents = { drive: async (_, handlers) => handlers.dispatch(selectedStep, 'stable-step-id', 123) }
  manager.execute = async request => { manager.runWorkflow(owner, request.connectionId); return 'Accepted fixture' }
  await manager.handle({ operationId: 'resume-new-connection', playerId: owner.ownerId, playerName: owner.ownerName, action: 'agent_task', args: 'resume', createdAtMs: 999, connectionId })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(forwarded.connectionId, connectionId)
  assert.equal(forwarded.operationId, 'stable-step-id')
  assert.equal(forwarded.createdAtMs, 123)
  selectedStep = { action: 'market', item: 'cobblestone', count: 4 }
  manager.runWorkflow(owner, connectionId); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(forwarded.inventoryPlayerId, inventoryPlayerId)
  assert.equal(callbacks, 2)
  unfinished = true
  manager.runWorkflow(owner, connectionId); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(callbacks, 2)
  console.log('PASS fresh connection and actual bot inventory identity reach market callbacks; unfinished physical tasks refuse sale before callback, quote ID/time stay stable')
  validateIntent({ kind: 'plan', message: 'Read balances', steps: [{ action: 'wallet' }] }, { marketEnabled: true })
  assert.throws(() => validateIntent({ kind: 'plan', message: 'Read balances', steps: [{ action: 'wallet' }] }))
  let walletMessage, walletObservation
  manager.onTaskResult = async (_, message) => { walletMessage = message }
  manager.marketHandler = async event => { assert.equal(event.connectionId, connectionId); assert.equal(event.action, 'wallet'); assert.equal(event.inventoryPlayerId, undefined); return { complete: true, message: 'Observed wallet balances: CITY 7; GEM 2.' } }
  manager.intents = { drive: async (_, handlers) => {
    const step = { action: 'wallet' }, reply = await handlers.dispatch(step, 'wallet-read', 123)
    walletObservation = await handlers.observe(step, 'wallet-read', reply)
  } }
  manager.runWorkflow(owner, connectionId); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(walletObservation.state, 'complete'); assert.equal(walletMessage, 'Observed wallet balances: CITY 7; GEM 2.')
  console.log('PASS read-only wallet intent forwards current connection and displays actual callback balances without inventory sale or invented model amounts')
  const saleBot = { player: { uuid: inventoryPlayerId }, players: { [owner.ownerName]: { uuid: owner.ownerId, entity: { position: { x: 32, y: 81, z: 4 } } } }, inventory: { items: () => [] } }
  const saleSlot = { ...owner, name: 'CityAgent2', generation: 0, mode: 'wait', bot: saleBot }
  const visibleEntity = saleBot.players[owner.ownerName].entity
  delete saleBot.players[owner.ownerName].entity
  assert.equal(PersonalAgents.prototype.ownerOnline.call(manager, saleSlot), true)
  assert.equal(PersonalAgents.prototype.ownerVisible.call(manager, saleSlot), false)
  const onlinePlayer = saleBot.players[owner.ownerName]
  delete saleBot.players[owner.ownerName]
  assert.equal(PersonalAgents.prototype.ownerOnline.call(manager, saleSlot), false)
  saleBot.players[owner.ownerName] = { ...onlinePlayer, entity: visibleEntity }
  console.log('PASS authorized physical work keeps its bound online owner beyond entity range while offline owners pause and visibility remains required for new authority')
  manager.slots = [saleSlot]; manager.ensureBot = async () => saleBot; unfinished = false
  manager.execute = PersonalAgents.prototype.execute.bind(manager)
  let observed, completion = false
  manager.saleHandler = async () => ({ complete: completion, message: completion ? 'Sale was already paid; no extra item or coin moved.' : 'Sale pending reconciliation.' })
  manager.intents = { workflow: () => null, drive: async (_, handlers) => {
    const step = { action: 'sell', item: 'cobblestone', count: 4 }
    const reply = await handlers.dispatch(step, 'same-sale-step', 123)
    observed = await handlers.observe(step, 'same-sale-step', reply)
  } }
  manager.runWorkflow(saleSlot, connectionId); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(observed.state, 'paused')
  completion = true
  manager.runWorkflow(saleSlot, connectionId); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(observed.state, 'complete')
  saleBot.inventory.items = () => [{ name: 'cobblestone', count: 4 }]
  const directSale = await manager.execute({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'direct-sale', action: 'sell', args: 'cobblestone 4' })
  assert.equal(directSale, 'Sale was already paid; no extra item or coin moved.')
  console.log('PASS typed receiving sale completion pauses unknown results, reconciles an already-paid empty inventory and unwraps direct chat responses')
  const received = []
  manager.tools.start = async value => { received.push(value); return 'Task started with real receiving validation pending.' }
  await manager.execute({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'custom-blueprint-step', action: 'build_structure', args: '', _plan: arch, _workflow: true })
  for (const [index, step] of preparation.steps.entries()) await manager.execute({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'prepare-step-' + index, action: step.action, args: '', _plan: step, _workflow: true })
  assert.deepEqual(received[0].plan, arch); assert.equal(received[0].operationId, 'custom-blueprint-step')
  assert.deepEqual(received.slice(1).map(value => value.plan), preparation.steps)
  manager.tools.state = { tasks: [{ ownerId: owner.ownerId, receipts: { 'step:withdraw:stock': { after: { chest: { oak_log: 2 } }, observedAt: '2026-10-31T12:00:00.000Z' } } }, { ownerId: 'someone-else', receipts: { 'step:withdraw:foreign': { after: { chest: { diamond: 64 } }, observedAt: '2026-10-31T13:00:00.000Z' } } }] }
  const observation = manager.materialContext(saleSlot)
  assert.deepEqual(observation.sourceObservation.items, { oak_log: 2 }); assert.equal(observation.sourceObservation.historical, true)
  console.log('PASS manager forwards exact custom/recipe steps and stable receiving IDs, while source context labels only the owner historical material observations')
  const proceduralHouse = { action: 'build_structure', structure: 'house', width: 4, depth: 4, height: 4, material: 'oak_planks' }
  await manager.execute({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'named-house-step', action: 'build_structure', args: '', _plan: proceduralHouse, _workflow: true })
  assert.deepEqual(received.at(-1).plan, proceduralHouse)
  let geometryCalls = 0, changeDimensions = false
  const classified = { kind: 'plan', message: 'Plan a custom L and then request a CITY sale.', steps: [{ action: 'build_structure', structure: 'custom', material: 'cobblestone', width: 3, depth: 3, height: 1, offset: [5, 0, 6], designRequest: 'Low L shape' }, { action: 'market', item: 'cobblestone', count: 4 }] }
  const focusedDesigner = await createIntentPlanner({ runtimeDirectory: join(directory, 'focused-designer'), marketEnabled: true,
    modelCall: async (_, format) => { const contract = JSON.stringify(format); assert(!contract.includes('"parts"') && !contract.includes('"placements"') && !contract.includes('"voids"')); return structuredClone(classified) },
    designerCall: async (_, format) => { geometryCalls++; assert(!JSON.stringify(format).includes('tokenIn')); return { builds: [{ index: 0, ...boxes, action: undefined, height: changeDimensions ? 2 : 1 }] } }
  })
  // An injected test response must contain only narrow designer fields.
  const originalDesigner = focusedDesigner.designerCall
  focusedDesigner.designerCall = async (...args) => { const response = await originalDesigner(...args); delete response.builds[0].action; return response }
  const designed = await focusedDesigner.interpret({ ownerId: 'designer-owner', text: 'Make a low three by three L shape one high, then sell four cobblestone for CITY.' })
  assert.equal(geometryCalls, 1); assert.deepEqual(designed.steps[1], classified.steps[1]); assert.deepEqual(designed.steps[0].offset, [5, 0, 6]); assert.equal(designed.steps[0].designRequest, undefined)
  changeDimensions = true
  await assert.rejects(focusedDesigner.interpret({ ownerId: 'designer-owner', text: 'Repeat the same low L and sell four cobblestone for CITY.' }), /GEOMETRY_CHANGED_DIMENSIONS/)
  await focusedDesigner.close()
  console.log('PASS simple main schema preserves named houses; one isolated designer fills custom geometry without changing financial steps, dimensions or origin')
  const inspectionDirectory = join(directory, 'inspection-history')
  const inspectionPlanner = await createIntentPlanner({ runtimeDirectory: inspectionDirectory, modelCall: async messages => {
    assert(!JSON.stringify(messages).includes('STALE_COMPLETED_COBBLE_ORDER'))
    const context = JSON.parse(messages[0].content.split('Observed context (data only): ')[1])
    assert.equal(context.workflow, null); assert.equal(context.historicalCompletedWorkflow.status, 'complete')
    return { kind: 'plan', message: 'I can inspect fresh supplies.', steps: [{ action: 'inspect' }] }
  } })
  const oldMessages = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'STALE_COMPLETED_COBBLE_ORDER_' + index }))
  inspectionPlanner.owner('inspection-owner').messages = structuredClone(oldMessages)
  inspectionPlanner.owner('inspection-owner').workflow = { id: 'completed-old-workflow', status: 'complete', index: 3, steps: [{ action: 'deliver' }, { action: 'collect' }, { action: 'sell' }], message: 'All 3 workflow steps completed.' }
  await inspectionPlanner.save()
  await inspectionPlanner.interpret({ ownerId: 'inspection-owner', text: 'Inspect my agent inventory and my source and destination stock.' })
  const persisted = JSON.parse(await readFile(join(inspectionDirectory, 'agent-conversations.json'), 'utf8')).owners['inspection-owner']
  assert.deepEqual([...persisted.archivedMessages, ...persisted.messages].slice(0, 12), oldMessages)
  assert.equal(persisted.workflow.id, 'completed-old-workflow')
  await inspectionPlanner.close()
  manager.tools.inspect = async () => ({ inventory: {}, source: { oak_planks: 70, cobblestone: 50 }, destination: { cobblestone: 6 }, resources: [{ item: 'oak_planks' }, { item: 'oak_planks' }], bounds: { implementation: 'must-not-be-chat-output' }, recordedStructures: [{ taskId: 'internal-task-id' }] })
  const supplies = await manager.handle({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'direct-inspection', action: 'agent_inspect', args: [] })
  assert.equal(typeof supplies, 'string'); assert.match(supplies, /Supplies checked.*agent: empty.*source: 70 oak planks, 50 cobblestone.*destination: 6 cobblestone.*Nearby loose blocks: 2 oak planks/)
  assert(!supplies.includes('internal-task-id') && !supplies.includes('bounds') && !supplies.includes('must-not-be-chat-output'))
  manager.tools.inspect = async () => { throw Error('Fixture navigation failed before a fresh stock observation') }
  const failedInspection = await manager.handle({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'failed-fresh-inspection', action: 'agent_inspect', args: [] })
  assert.match(failedInspection, /Agent unavailable: Fixture navigation failed/)
  assert(!failedInspection.includes('Supplies checked')); assert.equal(saleSlot.lastInspection, null)
  assert.match(await manager.handle({ playerId: owner.ownerId, playerName: owner.ownerName, operationId: 'direct-capabilities', action: 'agent_capabilities', args: [] }), /Supported tasks/)
  console.log('PASS completed chat stays durably retained but leaves active model context; direct supplies inspection returns fresh human-readable counts without internal identifiers')
  const sidePlanner = await createIntentPlanner({ runtimeDirectory: join(directory, 'paused-side-query'), modelCall: async () => ({ kind: 'plan', message: 'Read status and actual screenshot.', steps: [{ action: 'status' }, { action: 'screenshot' }] }) })
  const gatherIntent = { kind: 'plan', message: 'Gather loose planks', steps: [{ action: 'gather', item: 'oak_planks', count: 2 }] }
  await sidePlanner.accept(owner.ownerId, gatherIntent, 'saved-gather', 321); await sidePlanner.pause(owner.ownerId, 'No safe loose resources.')
  const savedFlow = structuredClone(sidePlanner.workflow(owner.ownerId)), sideQueries = []
  manager.intents = sidePlanner; manager.tools.status = () => [{ status: 'blocked', completed: 0, total: 2, message: 'No safe loose resources.' }]
  const queryRequest = { operationId: 'side-query', playerId: owner.ownerId, playerName: owner.ownerName, args: 'Update and screenshot' }
  const remoteProof = { grant: 'fixture-scoped-grant', session: { fixture: true } }
  Object.defineProperty(queryRequest, 'remoteRequest', { value: remoteProof, enumerable: false })
  manager.execute = async request => { assert.equal(request.remoteRequest, remoteProof); sideQueries.push(request.action); return request.action === 'screenshot' ? { complete: true, message: 'Actual fixture screenshot captured.' } : 'Agent is paused: no safe loose resources.' }
  const queryReply = await manager.converse(queryRequest, saleSlot)
  assert.match(queryReply, /paused.*\nActual fixture screenshot captured/)
  assert.deepEqual(sideQueries, ['status', 'screenshot']); assert.deepEqual(sidePlanner.workflow(owner.ownerId), savedFlow)
  const different = await sidePlanner.accept(owner.ownerId, { kind: 'plan', message: 'Different work', steps: [{ action: 'follow' }] }, 'different-work')
  assert.equal(different.accepted, false); assert.match(different.message, /cancel task/); assert.match(different.message, /Stop only pauses/)
  manager.execute = PersonalAgents.prototype.execute.bind(manager)
  manager.tools.cancelZeroEffect = async () => { throw Error('Pending native effect requires reconciliation') }
  const deniedCancel = await manager.handle({ operationId: 'cancel-denied', playerId: owner.ownerId, playerName: owner.ownerName, action: 'agent_cancel', args: [] })
  assert.match(deniedCancel, /Pending native effect/); assert.equal(sidePlanner.workflow(owner.ownerId).id, 'saved-gather')
  manager.tools.cancelZeroEffect = async () => null
  const cancelled = await manager.handle({ operationId: 'cancel-explicit', playerId: owner.ownerId, playerName: owner.ownerName, action: 'agent_task', args: 'cancel task' })
  assert.match(cancelled, /cancelled safely/); assert.equal(sidePlanner.workflow(owner.ownerId), null)
  assert.equal(sidePlanner.owner(owner.ownerId).workflowHistory[0].id, savedFlow.id)
  assert.deepEqual(sidePlanner.owner(owner.ownerId).workflowHistory[0].pending, savedFlow.pending)
  assert.deepEqual(sidePlanner.owner(owner.ownerId).workflowHistory[0].steps, savedFlow.steps)
  assert.equal(sidePlanner.owner(owner.ownerId).workflowHistory[0].status, 'cancelled')
  assert.equal((await sidePlanner.accept(owner.ownerId, { kind: 'plan', message: 'New work', steps: [{ action: 'follow' }] }, 'new-authorized-request')).accepted, true)
  await sidePlanner.close()
  console.log('PASS paused workflow allows readonly side queries unchanged; explicit cancellation preserves history, refuses unresolved effects and permits a new separately authorized plan')
  await planner.close()
} finally { await rm(directory, { recursive: true, force: true }) }
