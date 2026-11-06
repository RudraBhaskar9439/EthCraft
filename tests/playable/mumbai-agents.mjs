// Offline identity and bot fixtures; no live providers, Minecraft or financial actions.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createAgentManager, PersonalAgents, PERSONAL_AGENT_NAMES } from '../../backend/src/playable/agents.mjs'
import { approvedMumbaiOwner, createMumbaiAgentService, mumbaiAgentCommand, waitForMumbaiTaskPosition, restoreExistingMumbaiAgents } from '../../scripts/mumbai_agents.mjs'

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url))
const runtimeDirectory = await mkdtemp(join(tmpdir(), 'agentcity-mumbai-agents-'))
const playerId = '11111111-1111-4111-8111-111111111111', principalId = '22222222-2222-4222-8222-222222222222', connectionId = '33333333-3333-4333-8333-333333333333'
const current = { playerId, principalId, connectionId, playerName: 'Micro', online: true, pendingAuthentication: false, serverId: 'fixture-server' }
const identity = { getMinecraftOwner: async () => ({ ownerId: principalId, minecraftPlayerId: playerId, ownerName: 'micro' }) }
const calls = []
const api = async (path, body) => { calls.push({ path, body }); return path.startsWith('session?') ? { ...current } : {} }
const event = (args, fields = {}) => ({ operationId: randomUUID(), playerId, connectionId, action: 'agent', args, ...fields })
const world = { available: true, personalAgentCapacity: 5, initializedTaskPads: 5,
  mumbaiAgentBounds: { min: { x: 1670, y: 68, z: 2800 }, max: { x: 1760, y: 80, z: 2830 } }, mumbaiAgentSpawn: { x: 1690, y: 69, z: 2812 },
  taskRegions: [1, 2, 3, 4, 5].map(n => ({ slotName: 'CityAgent' + n, worldName: n < 4 ? 'agentcity_play' : 'agentcity_mumbai',
    min: { x: 1730, y: 69, z: 2810 }, max: { x: 1741, y: 75, z: 2821 }, origin: [1730, 69, 2810], sourceChest: [1730, 69, 2821], destinationChest: [1731, 69, 2821] })) }
const bots = []
let activeConnections = 0, maximumConcurrentConnections = 0
const botFactory = async options => {
  activeConnections++; maximumConcurrentConnections = Math.max(maximumConcurrentConnections, activeConnections)
  const bot = new EventEmitter()
  bot.username = options.username; bot.game = { gameMode: 'survival' }; bot.entity = { position: { x: 1690, y: 69, z: 2812 } }
  bot.players = { Micro: { uuid: playerId, entity: { position: { x: 1696, y: 69, z: 2812 } } } }
  bot.inventory = { items: () => [], slots: [] }; bot.pathfinder = { setGoal() {} }; bot.clearControlStates = () => {}; bot.quit = () => bot.emit('end')
  bot._client = new EventEmitter(); bot._client.state = 'play'; bot._client.write = () => {}
  setTimeout(() => { activeConnections--; bot._client.emit('login', { worldState: { name: 'minecraft:agentcity_mumbai' } }); bot.emit('spawn') }, 1)
  bots.push(bot); return bot
}
let service
try {
  assert.deepEqual(PERSONAL_AGENT_NAMES, ['CityAgent1', 'CityAgent2', 'CityAgent3'])
  for (const agentNames of [[], ['CityAgent4', 'CityAgent4'], ['Anyone']]) assert.throws(() => new PersonalAgents({ rootDirectory, runtimeDirectory, agentNames }), /INVALID_PERSONAL_AGENT_NAMES/)
  assert.throws(() => new PersonalAgents({ rootDirectory, runtimeDirectory, slotModelProviders: { CityAgent4: { kind: '0g', model: 'fixture' } } }), /INVALID_SLOT_MODEL_PROVIDERS/)
  assert.equal(mumbaiAgentCommand(event('0g task build a tower')).event.args, 'task build a tower')
  for (const [phrase, command] of [['mere peeche aao','follow'],['मेरे पीछे आओ','follow'],['idhar aao','come'],['रुको','wait']]) {
    assert.equal(mumbaiAgentCommand(event('0g ' + phrase)).event.args, command)
  }
  assert.equal(mumbaiAgentCommand(event(['claude', 'status'])).provider, 'claude')
  assert.equal(mumbaiAgentCommand(event(['agent', 'status'])).provider,'claude')
  assert.equal(mumbaiAgentCommand(event(['Agent','review'])).event.action,'agent')
  assert.equal(mumbaiAgentCommand(event('ollama create')), null)
  for(const prefix of ['0g','agent'])for(const [phrase,command]of [['follow me','follow'],['Please follow me!','follow'],['task follow me','follow'],['come here','come'],['Can you walk to me please?','come'],['stop following me','wait'],['wait here','wait'],['what are you doing','status']]){
    const parsed=mumbaiAgentCommand(event(prefix+' '+phrase)).event
    assert.equal(parsed.action,'agent');assert.equal(parsed.args,command)
  }
  assert.equal(mumbaiAgentCommand(event('0g build a house then follow me')).event.action,'agent_task')
  const naturalBuild = mumbaiAgentCommand(event('claude build a house')).event
  assert.equal(naturalBuild.action, 'agent_task'); assert.equal(naturalBuild.args, 'build a house')
  const numericBuild = mumbaiAgentCommand(event('claude build platform 3 3 oak_planks')).event
  assert.equal(numericBuild.action, 'agent'); assert.equal(numericBuild.args, 'build platform 3 3 oak_planks')
  const teleported = { bot: { entity: { position: { x: 1690, y: 69, z: 2812 } } } }, region = world.taskRegions[3]
  setTimeout(() => { teleported.bot.entity.position = { x: 1732, y: 69, z: 2812 } }, 5)
  await waitForMumbaiTaskPosition(teleported, region, 100)
  await waitForMumbaiTaskPosition(teleported, region, 0)
  teleported.bot.entity.position.x = 1690
  await assert.rejects(waitForMumbaiTaskPosition(teleported, region, 5), /MUMBAI_TASK_TELEPORT_TIMEOUT/)
  const attributed = await approvedMumbaiOwner({ identity, api, serverId: 'fixture-server' }, event('0g status'))
  assert.equal(attributed.playerId, principalId); assert.equal(attributed.actorPlayerId, playerId); assert.equal(attributed.playerName, 'Micro')
  await assert.rejects(approvedMumbaiOwner({ identity, api, serverId: 'fixture-server' }, event('0g status', { connectionId: randomUUID() })), /MUMBAI_APPROVED_CONNECTION_REQUIRED/)
  current.pendingAuthentication = true
  await assert.rejects(approvedMumbaiOwner({ identity, api, serverId: 'fixture-server' }, event('0g status')), /MUMBAI_APPROVED_CONNECTION_REQUIRED/)
  current.pendingAuthentication = false
  let restoredConnections = 0, identityReads = 0
  const restoreIdentity = { getMinecraftOwner: async (...args) => { identityReads++; assert.deepEqual(args, ['fixture-server', playerId]); return identity.getMinecraftOwner(...args) } }
  const persisted = { name: 'CityAgent4', ownerId: principalId, minecraftPlayerId: playerId, ownerName: 'Micro' }
  const recoveryService = slot => ({ managers: {
    '0g': { slots: [slot], ensureBot: async value => { assert.equal(value, slot); restoredConnections++ } },
    claude: { slots: [], ensureBot: async () => { throw Error('NO_FRESH_SLOTS_ALLOWED') } }
  } })
  assert.deepEqual(await restoreExistingMumbaiAgents({ service: recoveryService({ name: 'CityAgent4' }), identity: restoreIdentity, serverId: 'fixture-server' }), { restored: [], skipped: [] })
  assert.equal(restoredConnections, 0); assert.equal(identityReads, 0)
  for (const slot of [{ ...persisted, ownerId: randomUUID() }, { ...persisted, ownerName: 'OtherOwner' }, { ...persisted, name: 'CityAgent1' }]) {
    const result = await restoreExistingMumbaiAgents({ service: recoveryService(slot), identity: restoreIdentity, serverId: 'fixture-server' })
    assert.deepEqual(result.restored, []); assert.equal(result.skipped[0].error, 'MUMBAI_AGENT_RESTORE_OWNER_BINDING_REQUIRED')
    assert.equal(restoredConnections, 0)
  }
  const callsBeforeRecovery = calls.length
  current.online = false
  assert.deepEqual(await restoreExistingMumbaiAgents({ service: recoveryService(persisted), identity: restoreIdentity, serverId: 'fixture-server' }), { restored: ['CityAgent4'], skipped: [] })
  assert.equal(restoredConnections, 1); assert.equal(calls.length, callsBeforeRecovery)
  await assert.rejects(approvedMumbaiOwner({ identity, api, serverId: 'fixture-server' }, event('0g task build a platform')), /MUMBAI_APPROVED_CONNECTION_REQUIRED/)
  current.online = true
  console.log('PASS idle recovery reconnects only an existing canonical provider slot; unowned, renamed and wrong-owner slots stay disconnected, and offline owners still cannot task')
  const retained = JSON.stringify({ version: 1, agents: [{ name: 'CityAgent1', ownerId: randomUUID(), ownerName: 'LegacyFixture' }], operations: {} })
  await writeFile(join(runtimeDirectory, 'personal-agents.json'), retained)
  const providers = { '0g': { kind: '0g', model: 'glm-4.7', apiKey: 'fixture-secret-0g' }, claude: { kind: 'anthropic', model: 'fixture-claude', apiKey: 'fixture-secret-claude' } }
  service = await createMumbaiAgentService({ rootDirectory, runtimeDirectory, world, providers, identity, api, serverId: 'fixture-server', botFactory })
  await assert.rejects(createAgentManager({ rootDirectory, runtimeDirectory }), /EADDRINUSE/)
  await service.createForApprovedPlayer(playerId)
  assert.deepEqual(bots.map(bot => bot.username), ['CityAgent4', 'CityAgent5'])
  assert.equal(await readFile(join(runtimeDirectory, 'personal-agents.json'), 'utf8'), retained)
  for (const [provider, name] of [['0g', 'CityAgent4'], ['claude', 'CityAgent5']]) {
    const slots = service.managers[provider].status()
    assert.equal(slots.length, 1); assert.equal(slots[0].name, name); assert.equal(slots[0].ownerId, principalId); assert.equal(slots[0].ownerName, 'Micro')
    assert.equal(slots[0].provider, providers[provider].kind); assert.equal(slots[0].connected, true)
    assert(!JSON.stringify(slots).includes('fixture-secret'))
    assert.match(await service.handle(event(provider + ' status')), new RegExp(name))
  }
  for(const prefix of ['0g','agent']){
    const manager=service.managers[prefix==='agent'?'claude':prefix]
    manager.goals={follow:()=>({fixture:'follow'}),near:()=>({fixture:'come'})}
    manager.intents.requestModel=async()=>{throw Error('MOVEMENT_MUST_NOT_CALL_A_MODEL')}
    const savedOwner=manager.intents.owner(principalId),old=savedOwner.workflow
    const steps=[{action:'build',structure:'platform',width:2,depth:2,item:'oak_planks'}]
    savedOwner.workflow={id:'saved-workflow-fixture',status:'paused',index:0,steps,receipts:[{message:'Preserved earlier observation.'}]}
    assert.match(await service.handle(event(prefix+' follow me')),/will follow you/)
    assert.equal(savedOwner.workflow.status,'paused');assert.equal(savedOwner.workflow.index,0)
    assert.deepEqual(savedOwner.workflow.steps,steps);assert.equal(savedOwner.workflow.receipts.length,1)
    assert.equal(manager.slots[0].mode,'follow')
    assert.match(await service.handle(event(prefix+' come here')),/will come to you/)
    assert.equal(manager.slots[0].mode,'come')
    assert.match(await service.handle(event(prefix+' wait here')),/stopped and is waiting/)
    const unfinished=manager.tools.unfinished.bind(manager.tools)
    manager.tools.unfinished=()=>({status:'paused',pending:{effect:'unknown'}})
    assert.match(await service.handle(event(prefix+' follow me')),/reconciled before moving/)
    assert.equal(manager.slots[0].mode,'wait')
    manager.tools.unfinished=unfinished;savedOwner.workflow=old
  }
  assert(calls.every(call => !/financial|wallet|remote-grant/.test(call.path)))
  assert.equal(bots.length, 2)
  await service.close(); service = null
  service = await createMumbaiAgentService({ rootDirectory, runtimeDirectory, world, providers, identity, api, serverId: 'fixture-server', botFactory })
  maximumConcurrentConnections = 0
  current.online = false
  const beforePersistedRecovery = calls.length
  const recovery = await restoreExistingMumbaiAgents({ service, identity, serverId: 'fixture-server' })
  assert.deepEqual(recovery, { restored: ['CityAgent4', 'CityAgent5'], skipped: [] })
  assert.equal(calls.length, beforePersistedRecovery)
  assert.equal(maximumConcurrentConnections, 1)
  current.online = true
  await service.createForApprovedPlayer(playerId)
  assert.deepEqual(bots.map(bot => bot.username), ['CityAgent4', 'CityAgent5', 'CityAgent4', 'CityAgent5'])
  assert(Object.values(service.managers).every(manager => manager.status()[0].connected))
  assert.equal(await readFile(join(runtimeDirectory, 'personal-agents.json'), 'utf8'), retained)
  console.log('PASS two provider-specific Mumbai managers retain canonical owner and native spelling, reject stale/unapproved connections, fence legacy worker and preserve its records; no model requests')
} finally { await service?.close(); await rm(runtimeDirectory, { recursive: true, force: true }) }
