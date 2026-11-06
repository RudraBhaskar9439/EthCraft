import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Events } from '../../backend/node_modules/discord.js/src/index.js'
import { createDiscordBridge, discordCommands, discordFailureMessage } from '../../backend/src/discord/bot.mjs'
import { discordPublicConfig, openDiscordIdentityRuntime } from '../../backend/src/discord/runtime.mjs'
import { savedAgentDirectory } from '../../scripts/local_discord.mjs'

assert.deepEqual(discordCommands({ identityOnly: true, bankEnabled: true }).map(command => command.name).sort(), ['agents', 'join', 'profile', 'start'])
assert(discordCommands().some(command => command.name === 'wallet'))
assert.match(discordFailureMessage(Error('MINECRAFT_CONNECTION_BINDING_MISMATCH')), /Keep Minecraft connected.*\/join again/)
const appId = '123456789', userId = '234567890', guildId = '345678901'
const owner = { ownerId: '11111111-1111-4111-8111-111111111111', ownerName: 'Fixture' }
let forbidden = 0, publicPosts = 0, notificationReads = 0, registrations
const blocked = async () => { forbidden++; throw Error('Forbidden fixture callback') }
const pool = { query: async sql => { if (/SELECT n\./.test(sql)) notificationReads++; return { rows: [] } }, connect: blocked }
const client = new EventEmitter()
client.user = { id: appId }
client.guilds = { fetch: async () => ({ members: { fetch: async () => ({ id: userId }) } }) }
client.channels = { fetch: async () => { publicPosts++; throw Error('No public channel should be accessed') } }
client.login = async () => { queueMicrotask(() => client.emit(Events.ClientReady)) }
client.destroy = () => {}
const identity = { getOwner: async () => owner, issueGrant: blocked, beginSetup: async () => ({ loginUrl: 'https://example.invalid/fixture-setup' }), reserveMinecraft: async () => ({ message: 'Fixture profile reserved.' }), approveMinecraftJoin: blocked }
const agents = { status: () => [1, 2, 3, 4, 5].map(n => ({ name: 'CityAgent' + n, ownerId: n < 4 ? '22222222-2222-4222-8222-222222222222' : owner.ownerId, ownerName: n < 4 ? 'LegacyFixture' : owner.ownerName,
  ...(n > 3 ? { provider: n === 4 ? '0g' : 'anthropic' } : {}), tasks: [{ status: 'complete' }] })), handleRemote: blocked }
const bridge = await createDiscordBridge({ settings: { applicationId: appId, guildId, serverId: 'fixture', enabled: true, identityOnly: true, organizedServer: true }, pool, client, identity, agents,
  restClient: { put: async (_, request) => { registrations = request.body; return [] } }, marketplace: { handleDiscord: blocked }, worldAssets: { handleDiscord: blocked }, bank: { handleDiscord: blocked }, experienceFactory: blocked })
const replies = []
const interaction = (kind, commandName, customId) => ({ user: { id: userId }, guildId, id: '456789012', commandName, customId, values: ['CityAgent2'],
  isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isAutocomplete: () => kind === 'autocomplete', isModalSubmit: () => kind === 'modal',
  options: { getString: name => name === 'login' ? 'local' : 'Fixture' },
  deferReply: async () => {}, editReply: async value => replies.push(value), reply: async value => replies.push(value), respond: async value => replies.push(value) })
try {
  await bridge.start()
  assert.deepEqual(registrations.map(command => command.name).sort(), ['agents', 'join', 'profile', 'start'])
  assert.equal(publicPosts, 0)
  await bridge.interaction(interaction('command', 'start'))
  assert.match(replies.at(-1).content, /Mac-only local test/)
  await bridge.interaction(interaction('command', 'profile'))
  assert.equal(replies.at(-1).content, 'Fixture profile reserved.')
  await bridge.interaction(interaction('command', 'agents'))
  assert(!JSON.stringify(replies.at(-1)).includes('ac:create'))
  assert.equal(replies.at(-1).components[0].toJSON().components[0].options.length, 5)
  assert.deepEqual(replies.at(-1).embeds.map(embed => embed.toJSON().title), ['CityAgent4 · 0G · Fixture', 'CityAgent5 · Claude · Fixture'])
  await bridge.interaction(interaction('select', undefined, 'ac:select'))
  assert.deepEqual(replies.at(-1).components, [])
  for (const stale of [interaction('command', 'assets'), interaction('button', undefined, 'ac:bank-confirm:old'), interaction('button', undefined, 'ac:ask:CityAgent2'), interaction('modal', undefined, 'ac:work-submit:CityAgent2')]) {
    await bridge.interaction(stale)
    assert.match(replies.at(-1).content, /financial actions are disabled/)
  }
  await bridge.interaction(interaction('autocomplete', 'work'))
  assert.deepEqual(replies.at(-1), [])
  client.emit(Events.MessageCreate, { author: { id: userId, bot: false }, guildId: null, content: 'Build and buy assets', reply: blocked })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(bridge.execute(userId, 'fixture-task', 'task', 'Build'), /IDENTITY_ONLY/)
  await assert.rejects(bridge.createWork(userId, 'fixture-work', {}, 'Build'), /IDENTITY_ONLY/)
  await bridge.flush()
  assert.equal(notificationReads, 0); assert.equal(forbidden, 0); assert.equal(publicPosts, 0)
} finally { await bridge.close() }

const directory = await mkdtemp(join(tmpdir(), 'agentcity-identity-only-'))
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw Error('No network in identity-only fixture') }
try {
  for (const child of ['.local/discord', '.local/playable-testnet', 'private', '.local/playable-world/agentcity-playable-1234abcd']) await mkdir(join(directory, child), { recursive: true, mode: 0o700 })
  const credentialsFile = join(directory, 'private/privy.json')
  await writeFile(credentialsFile, JSON.stringify({ appSecret: 'fixture-app-secret' }), { mode: 0o600 })
  await writeFile(join(directory, '.local/discord/settings.json'), JSON.stringify({ applicationId: appId, guildId, serverId: 'fixture', identityOnly: true, origin: 'http://127.0.0.1:8789' }))
  await writeFile(join(directory, '.local/playable-testnet/wallet-settings.json'), JSON.stringify({ provider: 'privy', appId: 'fixture-privy-app', credentialsFile, playerOrigin: 'http://127.0.0.1:8789' }))
  assert.equal((await discordPublicConfig(directory)).walletSetupAvailable, false)
  const runtime = await openDiscordIdentityRuntime({ rootDirectory: directory, pool, pluginApi: blocked })
  try {
    await assert.rejects(runtime.walletForAccessToken('not-a-real-token'), /DISCORD_WALLET_DISABLED_IN_IDENTITY_ONLY_MODE/)
    await assert.rejects(runtime.authorizeRemote({}), /DISCORD_IDENTITY_ONLY_ACTION_DISABLED/)
  }
  finally { await runtime.close() }
  assert.equal(networkCalls, 0); assert.equal(forbidden, 0)
  const runtimePath = join(directory, '.local/playable-world/agentcity-playable-1234abcd')
  await writeFile(join(directory, '.local/playable-world/active.json'), JSON.stringify({ owner: 'agentcity-playable-pilot', container: 'agentcity-playable-1234abcd', runtime: runtimePath }))
  await writeFile(join(runtimePath, 'personal-agents.json'), JSON.stringify({ agents: [{ name: 'CityAgent2', ownerId: owner.ownerId, ownerName: 'Fixture' }] }))
  await writeFile(join(runtimePath, 'personal-agent-tasks.json'), JSON.stringify({ tasks: [{ ownerId: owner.ownerId, status: 'complete', secretContext: 'must-not-publish' }] }))
  const facade = savedAgentDirectory(directory)
  assert.equal(facade.status()[0].tasks[0].status, 'complete')
  assert(!JSON.stringify(facade.status()).includes('must-not-publish'))
  for (const [child, name] of [['mumbai-0g', 'CityAgent4'], ['mumbai-claude', 'CityAgent5']]) {
    await mkdir(join(runtimePath, child))
    await writeFile(join(runtimePath, child, 'personal-agents.json'), JSON.stringify({ agents: [{ name, ownerId: owner.ownerId, ownerName: 'Fixture', secretContext: 'must-not-publish' }] }))
  }
  assert.deepEqual(facade.status().map(slot => slot.name), ['CityAgent2', 'CityAgent4', 'CityAgent5'])
  assert.deepEqual(facade.status().slice(1).map(slot => slot.provider), ['0g', 'anthropic'])
  assert.deepEqual(facade.status().slice(1).map(slot => slot.tasks), [[], []])
  await writeFile(join(runtimePath, 'mumbai-claude', 'personal-agent-tasks.json'), JSON.stringify({ tasks: [{ ownerId: owner.ownerId, status: 'paused', prompt: 'must-not-publish' }] }))
  await writeFile(join(runtimePath, 'mumbai-claude', 'agent-conversations.json'), JSON.stringify({ owners: { [owner.ownerId]: { workflow: { status: 'paused', index: 0, steps: [{ prompt: 'must-not-publish' }], prompt: 'must-not-publish' } } } }))
  assert.equal(facade.status()[2].tasks[0].status, 'paused')
  assert.deepEqual(facade.status()[2].workflow, { status: 'paused', index: 0, steps: [{}] })
  assert(!JSON.stringify(facade.status()).includes('must-not-publish'))
  await assert.rejects(facade.handleRemote(), /IDENTITY_ONLY/)
  const source = await readFile(new URL('../../scripts/local_discord.mjs', import.meta.url), 'utf8')
  assert(!/createAgentManager|loadAgentModelProvider|loadZeroGProvider|requestAnthropicPlan|requestZeroGPlan/.test(source))
} finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }) }
console.log('PASS identity-only commands, stale controls/DM/work/notification fences, no startup posts, wallet blocked before provider, saved directory and no model/manager startup paths')
