import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from '../backend/node_modules/pg/lib/index.js'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'
import { createAgentManager } from '../backend/src/playable/agents.mjs'
import { loadZeroGProvider } from '../backend/src/inference/zero-g.mjs'
import { loadAgentModelProvider } from '../backend/src/inference/anthropic.mjs'
import { openDiscordIdentityRuntime } from '../backend/src/discord/runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export const mumbaiAgentSlots = Object.freeze({ '0g': 'CityAgent4', claude: 'CityAgent5' })
const help = 'Use /agent 0g create or /agent claude create, then /agent 0g task <request> or /agent claude task <request>. Status, inspect, follow, come and wait use the same provider prefix.'

// Reconnect persisted ownership only. Idle presence does not require the owner
// online; task execution still passes the existing approved-session guards.
export async function restoreExistingMumbaiAgents({ service, identity, serverId } = {}) {
  if (!service?.managers || typeof identity?.getMinecraftOwner !== 'function' || !serverId) throw Error('MUMBAI_AGENT_RESTORE_CONFIGURATION_REQUIRED')
  const restored = [], skipped = []
  for (const [provider, name] of Object.entries(mumbaiAgentSlots)) {
    const manager = service.managers[provider]
    if (!Array.isArray(manager?.slots) || typeof manager.ensureBot !== 'function') throw Error('MUMBAI_AGENT_RESTORE_CONFIGURATION_REQUIRED')
    for (const slot of manager.slots) {
      if (!slot.ownerId && !slot.minecraftPlayerId && !slot.ownerName) continue
      try {
        if (slot.name !== name || !UUID.test(slot.ownerId || '') || !UUID.test(slot.minecraftPlayerId || '') ||
          typeof slot.ownerName !== 'string' || !slot.ownerName) throw Error('MUMBAI_AGENT_RESTORE_OWNER_BINDING_REQUIRED')
        const owner = await identity.getMinecraftOwner(serverId, slot.minecraftPlayerId)
        if (!UUID.test(owner?.ownerId || '') || !UUID.test(owner?.minecraftPlayerId || '') ||
          slot.ownerId !== owner.ownerId.toLowerCase() || slot.minecraftPlayerId !== owner.minecraftPlayerId.toLowerCase() ||
          slot.ownerName.toLowerCase() !== owner.ownerName?.toLowerCase()) throw Error('MUMBAI_AGENT_RESTORE_OWNER_BINDING_REQUIRED')
        await manager.ensureBot(slot)
        restored.push(name)
      } catch (error) {
        skipped.push({ name, error: /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'MUMBAI_AGENT_RESTORE_UNAVAILABLE' })
      }
    }
  }
  return { restored, skipped }
}

export function mumbaiAgentCommand(event) {
  if (event?.action !== 'agent') return null
  const words = (Array.isArray(event.args) ? event.args.join(' ') : String(event.args || '')).trim().split(/\s+/)
  const provider = words.shift().toLowerCase()
  if (!Object.hasOwn(mumbaiAgentSlots, provider)) return null
  const request = words.join(' ') || 'status'
  const explicit = /^(?:create|follow|come|wait|status|inspect|capabilities|release|cancel|screenshot)$/.test(request) || /^task(?:\s|$)/.test(request) ||
    /^build (?:(?:platform|shelter) )?\d+ \d+(?: [a-z0-9_:]+)?$/.test(request) || /^(?:collect|deliver) [a-z0-9_:]+ \d+$/.test(request)
  return { provider, event: { ...event, action: explicit ? 'agent' : 'agent_task', args: request } }
}

export async function approvedMumbaiOwner({ identity, api, serverId }, event) {
  if (!UUID.test(event?.playerId || '') || !UUID.test(event?.connectionId || '')) throw Error('MUMBAI_APPROVED_CONNECTION_REQUIRED')
  const owner = await identity.getMinecraftOwner(serverId, event.playerId)
  const current = await api('session?playerId=' + encodeURIComponent(event.playerId))
  if (!UUID.test(owner?.ownerId || '') || owner.minecraftPlayerId?.toLowerCase() !== event.playerId.toLowerCase() ||
      current.online !== true || current.pendingAuthentication !== false || current.playerId?.toLowerCase() !== event.playerId.toLowerCase() ||
      current.connectionId?.toLowerCase() !== event.connectionId.toLowerCase() || current.principalId?.toLowerCase() !== owner.ownerId.toLowerCase() ||
      typeof current.playerName !== 'string' || current.playerName.toLowerCase() !== owner.ownerName?.toLowerCase() || current.serverId && current.serverId !== serverId) {
    throw Error('MUMBAI_APPROVED_CONNECTION_REQUIRED')
  }
  // The native spelling must match Mineflayer's visible player; the principal remains canonical.
  return { ...event, playerId: owner.ownerId.toLowerCase(), playerName: current.playerName, actorPlayerId: current.playerId.toLowerCase() }
}

export async function waitForMumbaiTaskPosition(slot, region, timeoutMs = 5000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5000) throw Error('MUMBAI_TASK_TELEPORT_TIMEOUT_BOUND')
  const inside = () => ['x', 'y', 'z'].every((axis, i) => Number.isFinite(slot.bot?.entity?.position?.[axis]) &&
    slot.bot.entity.position[axis] >= (region.min[axis] ?? region.min[i]) && slot.bot.entity.position[axis] <= (region.max[axis] ?? region.max[i]))
  const deadline = Date.now() + timeoutMs
  while (!inside()) {
    if (Date.now() >= deadline) throw Error('MUMBAI_TASK_TELEPORT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())))
  }
}

export async function createMumbaiAgentService({ rootDirectory, runtimeDirectory, world, providers, identity, api, serverId, botFactory } = {}) {
  if (world?.available !== true || world.personalAgentCapacity !== 5 || world.initializedTaskPads !== 5 || !world.mumbaiAgentBounds || !world.mumbaiAgentSpawn ||
      !Array.isArray(world.taskRegions) || Object.values(mumbaiAgentSlots).some(name => world.taskRegions.filter(region => region.slotName === name && region.worldName === 'agentcity_mumbai').length !== 1)) {
    throw Error('MUMBAI_AGENT_PLUGIN_UPGRADE_REQUIRED')
  }
  if (providers?.['0g']?.kind !== '0g' || providers?.claude?.kind !== 'anthropic') throw Error('MUMBAI_BOTH_HOSTED_PROVIDERS_REQUIRED')
  const release = await checkpoints.acquireLocalLease('personal-agents:' + resolve(runtimeDirectory))
  const managers = {}
  const connectionGap = botFactory ? 0 : 4500
  let connectionTail = Promise.resolve(), nextConnectionAt = Date.now() + connectionGap
  try {
    for (const [provider, slotName] of Object.entries(mumbaiAgentSlots)) {
      let manager
      manager = await createAgentManager({ rootDirectory, runtimeDirectory: join(runtimeDirectory, 'mumbai-' + provider),
        agentNames: [slotName], modelProvider: providers[provider], botFactory,
        playWorld: 'agentcity_mumbai', playSpawn: world.mumbaiAgentSpawn, movementBounds: world.mumbaiAgentBounds,
        taskRegions: world.taskRegions.filter(region => region.slotName === slotName),
        onTaskLock: async (slot, task, state) => {
          const current = await api('session?playerId=' + encodeURIComponent(slot.minecraftPlayerId || ''))
          if (!current.online || current.pendingAuthentication !== false || current.playerId?.toLowerCase() !== slot.minecraftPlayerId || current.principalId?.toLowerCase() !== slot.ownerId) throw Error('MUMBAI_APPROVED_OWNER_REQUIRED')
          const receipt = await api('task-lock', { slotName: slot.name, ownerId: slot.ownerId, ownerPlayerId: slot.minecraftPlayerId, taskId: task.id, locked: state.locked })
          if (state.locked) await waitForMumbaiTaskPosition(slot, world.taskRegions.find(region => region.slotName === slot.name))
          return receipt
        },
        onTaskResult: async (ownerId, message) => {
          const slot = manager.slots.find(slot => slot.ownerId === ownerId)
          if (slot?.minecraftPlayerId) await api('notify', { playerId: slot.minecraftPlayerId, message: `${provider}: ${message}`.slice(0, 3000) })
        }
      })
      const connect = manager.ensureBot.bind(manager)
      manager.ensureBot = slot => {
        if (slot.bot || slot.connecting) return connect(slot)
        const pending = connectionTail.then(async () => {
          if (slot.bot || slot.connecting) return connect(slot)
          const remaining = nextConnectionAt - Date.now()
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
          if (manager.closed) throw Error('MUMBAI_AGENT_SERVICE_STOPPED')
          try { return await connect(slot) }
          finally { nextConnectionAt = Date.now() + connectionGap }
        })
        connectionTail = pending.catch(() => {})
        return pending
      }
      managers[provider] = manager
    }
    return {
      managers,
      async handle(event) {
        const route = mumbaiAgentCommand(event)
        if (!route) return help
        const attributed = await approvedMumbaiOwner({ identity, api, serverId }, route.event)
        return managers[route.provider].handle(attributed)
      },
      async createForApprovedPlayer(playerId) {
        if (!UUID.test(playerId || '')) throw Error('MUMBAI_APPROVED_CONNECTION_REQUIRED')
        const current = await api('session?playerId=' + encodeURIComponent(playerId))
        for (const provider of Object.keys(mumbaiAgentSlots)) {
          const event = { action: 'agent', args: 'create', operationId: 'mumbai-create:' + provider + ':' + current.connectionId, playerId, connectionId: current.connectionId }
          const attributed = await approvedMumbaiOwner({ identity, api, serverId }, event)
          const manager = managers[provider], response = await manager.handle(attributed)
          const slot = manager.slots.find(slot => slot.name === mumbaiAgentSlots[provider] && slot.ownerId === attributed.playerId && slot.minecraftPlayerId === attributed.actorPlayerId)
          if (!slot) throw Error('MUMBAI_APPROVED_AGENT_CREATION_FAILED')
          await manager.ensureBot(slot)
          if (!slot.bot) throw Error('MUMBAI_APPROVED_AGENT_CREATION_FAILED')
          await api('notify', { playerId, message: response })
        }
      },
      async close() { await Promise.allSettled(Object.values(managers).map(manager => manager.close())); await release() }
    }
  } catch (error) { await Promise.allSettled(Object.values(managers).map(manager => manager.close())); await release(); throw error }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') { console.log('Usage: node scripts/mumbai_agents.mjs --run'); return }
  const active = await json(join(root, '.local/playable-world/active.json'))
  if (active.owner !== 'agentcity-playable-pilot' || !/^agentcity-playable-[a-f0-9]{8}$/.test(active.container)) throw Error('OWNED_PLAYABLE_WORLD_REQUIRED')
  const runtimeDirectory = join(root, '.local/playable-world', active.container)
  const token = (await readFile(join(runtimeDirectory, 'api-token'), 'utf8')).trim()
  const api = async (path, body) => {
    const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw Error('MUMBAI_NATIVE_HTTP_' + response.status)
    return response.json()
  }
  const configuration = await json(join(root, '.local/comparison/providers.json'))
  const providers = { '0g': await loadZeroGProvider(root, configuration.CityAgent2), claude: await loadAgentModelProvider(root, configuration.CityAgent3) }
  const environment = await json(join(root, '.local/backend/environment.json'))
  const pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 3 })
  let identity, service, stopped = false
  const stop = () => { stopped = true; for (const manager of Object.values(service?.managers || {})) for (const slot of manager.slots) manager.stop(slot, 'Mumbai agent host is stopping.') }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  const inFlight = new Map()
  try {
    identity = await openDiscordIdentityRuntime({ rootDirectory: root, pool, pluginApi: api })
    service = await createMumbaiAgentService({ rootDirectory: root, runtimeDirectory, world: await api('status'), providers, identity: identity.service, api, serverId: active.serverId })
    let setup
    try { setup = await json(join(root, '.local/mumbai/agents.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (setup) {
      if (setup.schema !== 'agentcity.mumbai-agents.v1' || !UUID.test(setup.approvedPlayerId || '') || Object.keys(setup).some(key => !['schema', 'approvedPlayerId'].includes(key))) throw Error('MUMBAI_AGENT_OWNER_CONFIGURATION_INVALID')
      try { await service.createForApprovedPlayer(setup.approvedPlayerId) }
      catch (error) { if (error.message !== 'MUMBAI_APPROVED_CONNECTION_REQUIRED') throw error; console.log('Mumbai owner is not currently approved online. Approve with /join, then use /agent 0g create and /agent claude create.') }
    }
    const restore = async () => {
      const result = await restoreExistingMumbaiAgents({ service, identity: identity.service, serverId: active.serverId })
      for (const skipped of result.skipped) console.error(`${skipped.name} idle reconnect skipped: ${skipped.error}`)
    }
    await restore()
    console.log('Mumbai agents ready: CityAgent4 uses 0G; CityAgent5 uses Claude. Startup makes no planning requests. Existing three agents and budgets are retained.')
    let nativeUnavailable = false
    while (!stopped) {
      try {
        const wasUnavailable = nativeUnavailable
        const { events } = await api('events'); nativeUnavailable = false
        if (wasUnavailable) await restore()
        for (const event of events) {
          if (!event.action?.startsWith('agent') || inFlight.has(event.operationId)) continue
          const work = (async () => {
            let message
            try { message = await service.handle(event) }
            catch (error) { message = 'Agent request stopped: ' + (/^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'MUMBAI_AGENT_REQUEST_UNAVAILABLE') }
            await api('ack', { operationId: event.operationId, message: String(message).slice(0, 3000) })
          })().catch(() => console.error('Mumbai agent acknowledgement pending; the queued event will retry.')).finally(() => inFlight.delete(event.operationId))
          inFlight.set(event.operationId, work)
        }
      } catch { if (!nativeUnavailable) console.error('Mumbai native service unavailable; requests remain queued.'); nativeUnavailable = true }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally { await Promise.allSettled(inFlight.values()); await service?.close(); await identity?.close(); await pool.end() }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'MUMBAI_AGENT_STARTUP_FAILED'); process.exitCode = 1 })
