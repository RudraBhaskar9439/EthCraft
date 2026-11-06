import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from '../backend/node_modules/pg/lib/index.js'
import { createDiscordBridge } from '../backend/src/discord/bot.mjs'
import { openDiscordIdentityRuntime } from '../backend/src/discord/runtime.mjs'
import { readDiscordConfiguration } from '../backend/src/discord/settings.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = file => JSON.parse(readFileSync(file, 'utf8'))

export function savedAgentDirectory(directory) {
  const active = json(join(directory, '.local/playable-world/active.json'))
  if (active.owner !== 'agentcity-playable-pilot' || !/^agentcity-playable-[a-f0-9]{8}$/.test(active.container)) throw Error('OWNED_PLAYABLE_WORLD_REQUIRED')
  const runtime = join(directory, '.local/playable-world', active.container)
  if (resolve(active.runtime) !== resolve(runtime)) throw Error('OWNED_PLAYABLE_RUNTIME_REQUIRED')
  return Object.freeze({
    status() {
      return ['', 'mumbai-0g', 'mumbai-claude'].flatMap(child => {
        const directory = join(runtime, child)
        let saved, tasks = [], conversations = { owners: {} }
        try { saved = json(join(directory, 'personal-agents.json')) } catch (error) { if (child && error.code === 'ENOENT') return []; throw error }
        try { tasks = json(join(directory, 'personal-agent-tasks.json')).tasks } catch (error) { if (error.code !== 'ENOENT') throw error }
        try { conversations = json(join(directory, 'agent-conversations.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        return saved.agents.map(({ name, ownerId, ownerName }) => {
          const workflow = conversations.owners[ownerId]?.workflow
          return { name, ownerId, ownerName, mode: 'saved status only', ...(child ? { provider: child === 'mumbai-0g' ? '0g' : 'anthropic' } : {}),
            tasks: tasks.filter(task => task.ownerId === ownerId).map(task => ({ status: task.status })),
            workflow: workflow ? { status: workflow.status, index: workflow.index, steps: workflow.steps.map(() => ({})) } : null }
        })
      })
    },
    async handleRemote() { throw Error('DISCORD_IDENTITY_ONLY_ACTION_DISABLED') }
  })
}

async function main() {
  if (process.argv.length !== 2) throw Error('LOCAL_DISCORD_IDENTITY_RUNTIME_TAKES_NO_ARGUMENTS')
  const settings = await readDiscordConfiguration(root, { required: true })
  if (!settings.enabled || settings.identityOnly !== true) throw Error('DISCORD_IDENTITY_ONLY_SETTING_REQUIRED')
  const environment = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  const pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 4 })
  let identity, bridge
  const stopped = new Promise(resolveStop => { process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop) })
  try {
    const agents = savedAgentDirectory(root)
    identity = await openDiscordIdentityRuntime({ rootDirectory: root, pool })
    bridge = await createDiscordBridge({ settings, pool, identity: identity.service, agents,
      gameSession: ({ owner }) => identity.pendingForOwner(owner),
      onReady: () => console.log('Local Discord identity service ready: /start, /profile, /join and read-only /agents. No model, financial or gameplay worker started.') })
    await bridge.start()
    await stopped
  } finally {
    await bridge?.close()
    await identity?.close()
    await pool.end()
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => {
  const code = /^[A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'LOCAL_DISCORD_IDENTITY_STARTUP_FAILED'
  console.error(code); process.exitCode = 1
})
