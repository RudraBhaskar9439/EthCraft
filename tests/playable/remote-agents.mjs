// Explicit authentication/bot/native-effect fixtures, not live Discord or Minecraft proof.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createAgentManager } from '../../backend/src/playable/agents.mjs'

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url))
const runtimeDirectory = await mkdtemp(join(tmpdir(), 'agentcity-remote-fixture-'))
const ownerId = randomUUID(), actorPlayerId = randomUUID(), botId = randomUUID(), otherOwner = randomUUID()
const ownerName = 'OfflineOwner'
const tools = ['status', 'inspect', 'screenshot', 'wait', 'build', 'gather', 'craft', 'collect', 'deliver', 'follow', 'come']
const region = { slotName: 'CityAgent1', ownerId, min: [24, 81, -10], max: [45, 84, 14], origin: [30, 81, 4], sourceChest: [25, 81, -9], destinationChest: [25, 81, -7] }
const world = { inventory: {}, source: { cobblestone: 8 }, destination: {}, withdrawals: 0 }
let active = true, selectedPlan = { kind: 'plan', message: 'Read status and capture a real view.', steps: [{ action: 'status' }, { action: 'screenshot' }] }, manager
let financialCalls = 0, captures = [], notices = [], lockMetadata = [], bots = []
const factory = async options => {
  const bot = new EventEmitter()
  Object.assign(bot, { username: options.username, game: { gameMode: 'survival' }, players: {}, entity: { position: { x: 32, y: 81, z: 4 } }, inventory: { items: () => Object.entries(world.inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), slots: [] }, pathfinder: { setGoal() {} }, clearControlStates() {}, quit() { bot.emit('end') }, player: { uuid: botId } })
  bot._client = new EventEmitter(); Object.assign(bot._client, { state: 'play', uuid: botId, write() {} })
  bots.push(bot)
  setTimeout(() => { bot._client.emit('login', { worldState: { name: 'minecraft:agentcity_play' } }); bot.emit('spawn') }, 1)
  return bot
}
const copy = value => structuredClone(value)
const adapter = {
  inventory: () => copy(world.inventory),
  block: () => 'air',
  chestCounts: async position => copy(position.join(',') === region.sourceChest.join(',') ? world.source : world.destination),
  withdraw: async (_, item, count) => { world.source[item] -= count; world.inventory[item] = (world.inventory[item] || 0) + count; world.withdrawals++ },
  deposit: async (_, item, count) => { world.inventory[item] -= count; world.destination[item] = (world.destination[item] || 0) + count }
}
const authorizeRemote = async request => {
  if (!active || request.session !== 'verified-session-fixture' || request.grant !== 'opaque-grant-fixture' || request.ownerId !== ownerId) throw Error('Refused explicit auth fixture')
  return { ownerId, ownerPlayerId: actorPlayerId, ownerName, principalId: ownerId, slotName: 'CityAgent1', agentId: 'CityAgent1', plotId: 'CityAgent1', grantId: 'verified-grant-fixture', expiresAtMs: Date.now() + 60_000, generation: 1, tools }
}
const remote = (action, args = '') => ({ operationId: randomUUID(), ownerId, ownerName, action, args, grant: 'opaque-grant-fixture', session: 'verified-session-fixture' })
const options = { rootDirectory, runtimeDirectory, playWorld: 'agentcity_play', taskRegions: [region], botFactory: factory, taskAdapterFactory: async () => adapter,
  authorizeRemote, intentModelCall: async () => copy(selectedPlan),
  onTaskLock: async slot => { lockMetadata.push(copy(slot.remoteContext)) },
  onTaskResult: async (_, message) => { notices.push(message) },
  saleHandler: async () => { financialCalls++; throw Error('Unexpected financial call') },
  marketHandler: async () => { financialCalls++; throw Error('Unexpected financial call') },
  marketContext: async () => { financialCalls++; throw Error('Unexpected financial context') },
  screenshotHandler: async input => { captures.push(input); return { complete: true, message: 'Actual capture handler fixture completed.', png: Buffer.from('PNG_FIXTURE_NOT_REAL_WORLD') } }
}
try {
  manager = await createAgentManager(options)
  assert.match(await manager.handleRemote({ ...remote('agent_create'), session: 'wrong' }), /refused/)
  assert.equal(bots.length, 0)
  assert.match(await manager.handleRemote(remote('agent_create')), /CityAgent1 is your personal agent/)
  assert.notEqual(ownerId, actorPlayerId)
  assert.equal(manager.slots[0].remoteContext.ownerId, ownerId)
  assert.match(await manager.handleRemote({ ...remote('agent_status'), ownerId: actorPlayerId }), /refused/)
  manager.authorizeRemote = async request => ({ ...await authorizeRemote(request), ownerId: otherOwner })
  assert.match(await manager.handleRemote(remote('agent_status')), /refused/)
  manager.authorizeRemote = async request => ({ ...await authorizeRemote(request), principalId: otherOwner })
  assert.match(await manager.handleRemote(remote('agent_status')), /refused/)
  manager.authorizeRemote = authorizeRemote
  assert.match(await manager.handleRemote(remote('agent_cancel')), /cancelled safely/)
  console.log('PASS Discord principal remains the agent owner after a different Minecraft UUID is linked; alias impersonation and conflicting canonical owners stay refused')
  assert.deepEqual(bots[0].players, {}, 'No fake online human was inserted')
  const delivery = remote('agent_deliver', 'cobblestone 2')
  assert.match(await manager.handleRemote(delivery), /Task .*started/)
  await manager.tools.idle()
  assert.equal(world.source.cobblestone, 6); assert.equal(world.destination.cobblestone, 2)
  assert.equal(manager.physicalOwnerReady(manager.slots[0]), true)
  assert.equal(lockMetadata[0].ownerId, ownerId); assert.equal(lockMetadata[0].slotName, 'CityAgent1'); assert.equal(lockMetadata[0].grantId, 'verified-grant-fixture')
  await manager.handleRemote(delivery); await manager.tools.idle(); assert.equal(world.withdrawals, 1)
  const physicalGrant = manager.slots[0].remoteContext, completedTask = manager.tools.state.tasks[0]
  completedTask.status = 'running'
  manager.installRemote(manager.slots[0], { action: 'status', operationId: 'read-status', remoteRequest: {} }, { ...physicalGrant, grantId: 'readonly-grant', tools: ['status', 'screenshot'] })
  assert.equal(manager.slots[0].remoteContext, physicalGrant, 'A read command cannot replace an active physical lease')
  completedTask.status = 'complete'
  const originalScopes = physicalGrant.tools
  physicalGrant.tools = ['status', 'screenshot']; manager.slots[0].remoteAction = 'screenshot'
  assert.equal(manager.physicalOwnerReady(manager.slots[0]), false, 'Continuation checks actual delivery scope, not the latest read action')
  physicalGrant.tools = originalScopes; manager.slots[0].remoteAction = 'deliver'
  console.log('PASS explicit remote auth fixture permits offline native task start/continuation with scoped lock metadata and stable replay; no fake human')

  assert.match(await manager.handle({ operationId: randomUUID(), playerId: ownerId, playerName: ownerName, action: 'agent_deliver', args: 'cobblestone 2' }), /cannot see/)
  assert.equal(world.source.cobblestone, 6)
  assert.match(await manager.handleRemote({ ...remote('agent_status'), ownerId: otherOwner }), /refused/)
  assert.match(await manager.handleRemote({ ...remote('agent_status'), connectionId: randomUUID() }), /refused/)
  assert.match(await manager.handleRemote(remote('agent_sell', 'cobblestone 1')), /financial actions are disabled/)
  selectedPlan = { kind: 'plan', message: 'Proposed mixed workflow', steps: [{ action: 'deliver', item: 'cobblestone', count: 2 }, { action: 'sell', item: 'cobblestone', count: 4 }] }
  assert.match(await manager.handleRemote(remote('agent_task', 'deliver two cobblestone and sell four cobblestone')), /workflow was not started/)
  assert.equal(world.source.cobblestone, 6); assert.equal(financialCalls, 0)
  assert.match(await manager.handleRemote(remote('agent_inspect')), /Supplies checked.*source: 6 cobblestone.*destination: 2 cobblestone/)
  assert.deepEqual(bots[0].players, {})
  console.log('PASS game commands retain visibility checks; wrong owner, forged game connection and remote financial plans fail before effects or provider calls')

  selectedPlan = { kind: 'plan', message: 'Status and actual screenshot', steps: [{ action: 'status' }, { action: 'screenshot' }] }
  assert.match(await manager.handleRemote(remote('agent_task', 'update and screenshot')), /Workflow accepted/)
  await manager.intents.running.get(ownerId)
  assert.equal(captures.length, 1); assert.equal(captures[0].bot, manager.getBot(ownerId)); assert.equal(captures[0].ownerId, ownerId)
  assert.equal(captures[0].remoteContext.grantId, 'verified-grant-fixture')
  assert.equal(captures[0].session, 'verified-session-fixture'); assert.equal(captures[0].path, undefined); assert.equal(captures[0].recipient, undefined)
  assert(notices.some(message => message.includes('CityAgent1:'))); assert(notices.includes('Actual capture handler fixture completed.'))
  assert.equal(manager.getBot(otherOwner), null); assert.deepEqual(manager.status(otherOwner), [])
  const saved = await readFile(join(runtimeDirectory, 'personal-agents.json'), 'utf8')
  assert(!saved.includes('verified-session-fixture') && !saved.includes('opaque-grant-fixture') && !saved.includes('PNG_FIXTURE_NOT_REAL_WORLD'))
  console.log('PASS combined status/screenshot uses only the actual owned bot callback and trusted audience context; image bytes and opaque auth stay out of journals')

  bots[0].players[ownerName] = { uuid: actorPlayerId, entity: { position: { x: 35, y: 81, z: 4 } } }
  assert.equal(manager.ownerVisible(manager.slots[0]), false)
  await manager.handle({ operationId: randomUUID(), playerId: ownerId, playerName: ownerName, actorPlayerId, action: 'agent_status' })
  assert.equal(manager.slots[0].ownerId, ownerId); assert.equal(manager.slots[0].minecraftPlayerId, actorPlayerId); assert.equal(manager.ownerVisible(manager.slots[0]), true)
  assert.match(await manager.handle({ operationId: randomUUID(), playerId: ownerId, playerName: ownerName, actorPlayerId: randomUUID(), action: 'agent_status' }), /binding changed/)
  console.log('PASS canonical Discord owner UUID stays distinct from the later verified Minecraft actor UUID; conflicting actor remapping is refused')

  manager.slots[0].remoteExecution = true
  manager.slots[0].remoteContext.validUntilMs = Date.now() - 1
  assert.equal(manager.physicalOwnerReady(manager.slots[0]), false)
  await manager.refreshRemoteAuthorizations(); assert.equal(manager.physicalOwnerReady(manager.slots[0]), true)
  const taskId = manager.tools.state.tasks[0].id
  active = false; await manager.revokeRemote('verified-grant-fixture')
  assert.equal(manager.physicalOwnerReady(manager.slots[0]), false, 'Online human cannot silently renew a revoked remote execution')
  assert.match(await manager.handleRemote(delivery), /refused/, 'Even a replay must reauthenticate')
  assert.equal(manager.tools.state.tasks[0].id, taskId); assert.equal(world.withdrawals, 1)
  await manager.close(); manager = await createAgentManager(options)
  assert.equal(manager.slots[0].minecraftPlayerId, actorPlayerId); assert.equal(manager.slots[0].ownerId, ownerId)
  assert.equal(manager.slots[0].bot, null); assert.equal(manager.slots[0].remoteContext, undefined)
  console.log('PASS stale/revoked remote authority pauses without losing receipts; restart preserves owner/actor binding and never restores an unauthenticated offline execution')
} finally { await manager?.close(); await rm(runtimeDirectory, { recursive: true, force: true }) }
