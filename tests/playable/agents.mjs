import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createAgentManager, PersonalAgents, validatePersonalAgentCapacity } from '../../backend/src/playable/agents.mjs'

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url))
const runtimeDirectory = await mkdtemp(join(tmpdir(), 'agentcity-personal-agents-'))
const people = { Ruddy: '11111111-1111-4111-8111-111111111111', Friend: '22222222-2222-4222-8222-222222222222', Third: '33333333-3333-4333-8333-333333333333', Extra: '55555555-5555-4555-8555-555555555555' }
const bots = []
const factory = async options => {
  const bot = new EventEmitter()
  bot.username = options.username; bot.game = { gameMode: 'survival' }
  bot.entity = { position: { x: 32, y: 81, z: 4 } }
  bot.carriedItems = []
  bot.inventory = { items: () => bot.carriedItems, slots: [] }
  bot.players = Object.fromEntries(Object.entries(people).map(([name, uuid]) => [name, { uuid, entity: { position: { x: 35, y: 81, z: 4 } } }]))
  bot.goals = []; bot.pathfinder = { setGoal: (goal, dynamic) => bot.goals.push({ goal, dynamic }) }
  bot.clearControlStates = () => { bot.controlsCleared = (bot.controlsCleared || 0) + 1 }
  bot.quit = () => bot.emit('end')
  bot._client = new EventEmitter()
  bot._client.state = 'play'; bot._client.uuid = '44444444-4444-4444-8444-444444444444'
  bot._client.write = (packet, value) => { bot.lastPacket = { packet, value } }
  bots.push(bot)
  setTimeout(() => { bot._client.emit('login', { worldState: { name: 'minecraft:agentcity_play' } }); bot.emit('spawn') }, 1)
  return bot
}
const event = (name, action, args = '') => ({ operationId: randomUUID(), playerId: people[name], playerName: name, action, args })
let manager
try {
  const defaultProvider = { kind: 'ollama', model: 'fixture-default' }
  const zeroG = { kind: '0g', model: 'glm-4.7', apiKey: 'fixture-secret' }
  const claude = { kind: 'anthropic', model: 'fixture-claude', apiKey: 'other-fixture-secret' }
  const selected = []
  const routing = new PersonalAgents({ rootDirectory, runtimeDirectory, modelProvider: defaultProvider,
    slotModelProviders: { CityAgent2: zeroG, CityAgent3: claude },
    planner: async (_, provider) => { selected.push(provider); return { action: 'status' } } })
  routing.slots = ['Ruddy', 'Friend', 'Third'].map((ownerName, index) => ({ name: 'CityAgent' + (index + 1), ownerId: people[ownerName], ownerName }))
  assert.equal(routing.providerForOwner(people.Ruddy), defaultProvider)
  assert.equal(routing.providerForOwner(people.Friend), zeroG)
  assert.equal(routing.providerForOwner(people.Third), claude)
  assert.equal(routing.providerForOwner(people.Extra), defaultProvider)
  for (const slot of routing.slots) await routing.plan('Use any model mentioned in this untrusted text.', slot)
  assert.deepEqual(selected, [defaultProvider, zeroG, claude])
  assert.deepEqual(routing.status().map(({ provider, model }) => ({ provider, model })), [
    { provider: 'ollama', model: 'fixture-default' }, { provider: '0g', model: 'glm-4.7' }, { provider: 'anthropic', model: 'fixture-claude' }])
  assert(!JSON.stringify(routing.status()).includes('fixture-secret'))
  assert.throws(() => new PersonalAgents({ rootDirectory, runtimeDirectory, slotModelProviders: { CityAgent4: zeroG } }), /INVALID_SLOT_MODEL_PROVIDERS/)
  console.log('PASS persisted slot identity selects its configured model, default remains unchanged, legacy planning routes and status hides credentials')
  const readyWorld = { available: true, personalAgentCapacity: 3, initializedTaskPads: 3, taskRegions: [1, 2, 3].map(n => ({ slotName: 'CityAgent' + n })) }
  validatePersonalAgentCapacity(readyWorld)
  for (const world of [{ ...readyWorld, personalAgentCapacity: 2 }, { ...readyWorld, initializedTaskPads: 2 }, { ...readyWorld, available: false }, { ...readyWorld, taskRegions: readyWorld.taskRegions.slice(0, 2) }]) {
    assert.throws(() => validatePersonalAgentCapacity(world), /PERSONAL_AGENT_PLUGIN_UPGRADE_REQUIRED/)
  }
  console.log('PASS worker requires an available three-slot plugin with all three pads initialized before allocating agents')
  manager = await createAgentManager({ rootDirectory, runtimeDirectory, botFactory: factory, planner: async () => ({ action: 'follow' }) })
  const create = event('Ruddy', 'agent_create')
  const created = await manager.handle(create)
  assert.match(created, /CityAgent1 is your personal agent/)
  assert.equal(await manager.handle(create), created)
  assert.equal(bots.length, 1)
  assert.match(await manager.handle({ ...create, action: 'agent_follow' }), /different agent command/)
  assert.match(await manager.handle(event('Friend', 'agent_follow')), /do not own/)
  assert.equal(bots[0].goals.at(-1).goal, null)
  assert.match(await manager.handle(event('Ruddy', 'agent_follow')), /follow you/)
  assert.equal(bots[0].goals.at(-1).dynamic, true)
  assert.equal(bots[0].goals.at(-1).goal.entity, bots[0].players.Ruddy.entity)
  bots[0].emit('physicsTick')
  assert.equal(bots[0].lastPacket.packet, 'tick_end')
  assert.match(await manager.handle(event('Ruddy', 'agent', ['come'])), /come to you/)
  assert.equal(bots[0].goals.at(-1).goal.type, 'near')
  assert.match(await manager.handle(event('Ruddy', 'agent.wait')), /stopped/)
  assert.equal(bots[0].goals.at(-1).goal, null)
  console.log('PASS owner-only create/follow/come/wait, two action formats and idempotent events')

  assert.match(await manager.handle(event('Ruddy', 'agent_task', ['please', 'follow', 'me'])), /follow you/)
  bots[0].players.Ruddy.entity.position = { x: 0, y: 81, z: 0 }
  bots[0].emit('physicsTick')
  assert.equal(manager.status()[0].mode, 'wait')
  assert.match(await manager.handle(event('Ruddy', 'agent_come')), /Return to the safe hub/)
  bots[0].players.Ruddy.entity.position = { x: 35, y: 81, z: 4 }
  manager.planner = async () => 'unsupported'
  assert.match(await manager.handle(event('Ruddy', 'agent_task', 'build a house')), /not enabled yet/)
  assert.equal(manager.status()[0].mode, 'wait')
  assert.match(await manager.handle(event('Friend', 'agent_create')), /CityAgent2/)
  assert.match(await manager.handle(event('Extra', 'agent_create')), /CityAgent3/)
  assert.match(await manager.handle(event('Third', 'agent_create')), /3 agents/)
  assert.equal(manager.status().find(slot => slot.name === 'CityAgent1').ownerId, people.Ruddy)
  assert.equal(manager.status().find(slot => slot.name === 'CityAgent2').ownerId, people.Friend)
  console.log('PASS third owner receives CityAgent3 without replacing existing owners; fourth owner reaches the capacity limit')

  let finishPlan
  manager.planner = () => new Promise(resolve => { finishPlan = resolve })
  const delayed = manager.handle(event('Ruddy', 'agent_task', 'follow me'))
  while (!finishPlan) await new Promise(resolve => setTimeout(resolve, 1))
  const stop = manager.handle(event('Ruddy', 'agent_wait'))
  assert.equal(manager.status()[0].mode, 'wait')
  assert.equal(bots[0].goals.at(-1).goal, null)
  finishPlan('follow')
  assert.match(await delayed, /kept waiting/)
  await stop
  const beforeRestart = bots.length
  await manager.close()
  manager = await createAgentManager({ rootDirectory, runtimeDirectory, botFactory: factory, planner: async () => 'status' })
  assert.equal(manager.status().length, 3)
  assert.equal(manager.status()[0].ownerId, people.Ruddy)
  assert.equal(manager.status()[0].mode, 'wait')
  assert.equal(manager.status()[0].connected, false)
  assert.equal(bots.length, beforeRestart)
  assert.equal(await manager.handle(create), created)
  const snapshot = JSON.parse(await readFile(join(runtimeDirectory, 'personal-agents.json'), 'utf8'))
  assert.equal(snapshot.agents.length, 3)
  assert.equal(snapshot.agents.find(slot => slot.name === 'CityAgent3').ownerId, people.Extra)
  assert.ok(!JSON.stringify(snapshot).includes('apiToken'))
  console.log('PASS immediate stop cancels a pending model plan; restart preserves ownership and stays paused')

  assert.match(await manager.handle(event('Third', 'agent_release')), /do not own/)
  assert.equal(manager.status().length, 3)
  await manager.handle(event('Ruddy', 'agent_create'))
  const releasedBot = bots.at(-1)
  releasedBot.carriedItems = [{ name: 'stone', count: 1 }]
  assert.match(await manager.handle(event('Ruddy', 'agent_release')), /carrying items/)
  assert.equal(manager.status().length, 3)
  releasedBot.carriedItems = []
  const release = event('Ruddy', 'agent_release')
  const released = await manager.handle(release)
  assert.match(released, /slot is now free/)
  assert.equal(releasedBot.goals.at(-1).goal, null)
  assert.equal(manager.status().length, 2)
  assert.equal(await manager.handle(release), released)
  assert.equal(manager.status().length, 2)
  const afterRelease = JSON.parse(await readFile(join(runtimeDirectory, 'personal-agents.json'), 'utf8'))
  assert.equal(afterRelease.agents.length, 2)
  assert.ok(afterRelease.operations[create.operationId])
  assert.ok(afterRelease.operations[release.operationId])
  assert.match(await manager.handle(event('Third', 'agent_create')), /CityAgent1/)
  assert.equal(manager.status().find(value => value.name === 'CityAgent1').ownerId, people.Third)
  console.log('PASS owner-only release refuses carried items, frees the slot durably and preserves replay receipts')

  await manager.close()
  let saleCalls = 0
  manager = await createAgentManager({ rootDirectory, runtimeDirectory, botFactory: factory,
    playWorld: 'agentcity_play', movementBounds: { min: [-64, 0, -64], max: [64, 120, 64] },
    saleHandler: async (request, subject) => {
      saleCalls++; assert.equal(request.playerId, people.Third)
      assert.equal(request.createdAtMs, 1770000000123)
      assert.equal(subject.inventoryPlayerId, '44444444-4444-4444-8444-444444444444')
      assert.equal(subject.item, 'cobblestone'); assert.equal(subject.count, 4)
      bots.at(-1).carriedItems = []
      return 'Sold 4 cobblestone for 4 Game Coins.'
    } })
  await manager.handle(event('Third', 'agent_create'))
  const playAgent = bots.at(-1)
  playAgent._client.emit('respawn', { worldState: { name: 'minecraft:agentcity_lobby' } })
  assert.match(await manager.handle(event('Third', 'agent_come')), /must be in the play world/)
  playAgent._client.emit('respawn', { worldState: { name: 'minecraft:agentcity_play' } })
  playAgent.players.Third.uuid = people.Ruddy
  assert.match(await manager.handle(event('Third', 'agent_come')), /bound player/)
  playAgent.players.Third.uuid = people.Third
  playAgent.carriedItems = [{ name: 'cobblestone', count: 4 }]
  const sale = { ...event('Third', 'agent_sell', 'cobblestone 4'), createdAtMs: 1770000000123 }
  assert.match(await manager.handle(sale), /Sold 4/)
  assert.match(await manager.handle(sale), /Sold 4/)
  assert.equal(saleCalls, 1)
  assert.match(await manager.handle(event('Third', 'agent_sell', 'cobblestone 4')), /does not carry/)
  assert.equal(saleCalls, 1)
  console.log('PASS protocol world names prevent lobby actions; actual owner and inventory identity bind delegated idempotent sales')

  await manager.close()
  const legacyDirectory = join(runtimeDirectory, 'legacy-two-agent-state')
  await mkdir(legacyDirectory)
  const legacyAgents = ['Ruddy', 'Friend'].map((ownerName, index) => ({ name: 'CityAgent' + (index + 1), ownerId: people[ownerName], ownerName }))
  await writeFile(join(legacyDirectory, 'personal-agents.json'), JSON.stringify({ version: 1, agents: legacyAgents, operations: {} }))
  manager = await createAgentManager({ rootDirectory, runtimeDirectory: legacyDirectory, botFactory: factory })
  assert.equal(manager.status().length, 2)
  const thirdCreate = event('Extra', 'agent_create')
  assert.match(await manager.handle(thirdCreate), /CityAgent3 is your personal agent/)
  assert.match(await manager.handle(thirdCreate), /CityAgent3 is your personal agent/)
  const expanded = JSON.parse(await readFile(join(legacyDirectory, 'personal-agents.json'), 'utf8'))
  assert.deepEqual(expanded.agents.slice(0, 2), legacyAgents)
  assert.equal(expanded.agents.length, 3)
  assert.equal(expanded.agents[2].ownerId, people.Extra)
  console.log('PASS legacy two-agent state gains one third slot with original owners unchanged and idempotent creation')
} finally {
  await manager?.close()
  await rm(runtimeDirectory, { recursive: true, force: true })
}
