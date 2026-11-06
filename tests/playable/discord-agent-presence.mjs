// Explicit SDK event fixtures; no Discord login, registration, send or live identity claim.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createAgentPresence } from '../../backend/src/discord/agent-presence.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { Events, GatewayIntentBits, PermissionsBitField } = require('discord.js')
const settings = { applicationId: '10000', guildId: '20000' }
const slots = [{ name: 'Agent_A', ownerId: 'owner-a', connected: true, mode: 'task' }, { name: 'Agent_B', ownerId: 'owner-b', connected: false }, { name: 'Future_User_Agent', ownerId: 'owner-c', connected: false }]
const owners = { '30000': { ownerId: 'owner-a', discordUserId: '30000' }, '40000': { ownerId: 'owner-b', discordUserId: '40000' } }
const calls = [], work = [], dms = [], deliveries = [], clients = []
let deniedMembership = false
const base = { settings, agents: { status: () => slots }, identity: { async getOwner(id) { if (!owners[id]) throw Error('UNVERIFIED'); return owners[id] } },
  executeOwner: async (...args) => { calls.push(args); return 'Actual tool fixture response' },
  createWork: async (...args) => { work.push(args); return 'Work request recorded; no permission or payment granted' }, resolveOwner: async id => Object.values(owners).find(owner => owner.ownerId === id) }
const credentials = { schema: 'agentcity.discord-agent-credentials.v1', agents: { Agent_A: { applicationId: '50000', botToken: 'a'.repeat(35) }, Agent_B: { applicationId: '60000', botToken: 'b'.repeat(35) } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function clientFactory(options) {
  assert(!options.intents.includes(GatewayIntentBits.MessageContent))
  const client = new EventEmitter(); clients.push(client)
  const botId = clients.length === 1 ? '50000' : '60000'
  client.user = { id: botId, setPresence(value) { client.presence = value } }
  client.application = { commands: { async set(commands, guildId) { assert.equal(guildId, settings.guildId); assert.equal(commands[0].name, 'ask'); client.registered = true } } }
  client.guilds = { async fetch(id) {
    assert.equal(id, settings.guildId)
    return { id: settings.guildId, members: { async fetch(id) {
      if (deniedMembership && id === '30000') throw Error('not member')
      return { user: { bot: ['50000', '60000'].includes(id) } }
    } } }
  } }
  client.users = { async fetch(id) { return { async send(payload) { dms.push({ botId, id, payload }); return { id: 'dm-message', channelId: 'dm' } } } } }
  client.login = async token => {
    assert.equal(token, botId === '50000' ? 'a'.repeat(35) : 'b'.repeat(35))
    // SDK login can resolve before ClientReady; startup must wait for real readiness.
    setImmediate(() => client.emit(Events.ClientReady)); return token
  }
  client.destroy = () => { client.destroyed = true }
  return client
}
function message({ id = 'message-1', userId = '30000', text = 'Build a wall', guildId = null, bot = false, mentioned = true } = {}) {
  const value = { id, author: { id: userId, bot }, content: text, guildId, channelId: guildId ? 'public' : 'dm', replies: [], mentions: { has: () => mentioned },
    async reply(payload) { value.replies.push(payload); return { id: 'reply' } } }
  return value
}
const pending = createAgentPresence({ ...base, clientFactory })
assert.equal((await pending.start()).configured, false); assert.equal(clients.length, 0)
assert(pending.status().agents.every(agent => agent.state === 'provisioning_required'))
await pending.close()
console.log('PASS missing per-agent application credentials remain explicitly pending without creating clients or registering commands')
let useLayoutRelay = true
const view = PermissionsBitField.Flags.ViewChannel, roomMessages = []
const overwrite = (id, allow = 0n, deny = 0n) => ({ id, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) })
const privateRoom = { id: 'private-room', guildId: settings.guildId, type: 0, permissionOverwrites: { cache: new Map([
  ['20000', overwrite('20000', 0n, view)], ['30000', overwrite('30000', view)], ['50000', overwrite('50000', view)], ['10000', overwrite('10000', view)]
]) }, async send(payload) { roomMessages.push(payload); return { id: 'private-reply', channelId: 'private-room' } } }
const presence = createAgentPresence({ ...base, credentials, clientFactory, roomProvider: async () => privateRoom,
  roomDelivery: async value => { if (!useLayoutRelay) return null; deliveries.push(value); return { id: 'actual-fixture-send-receipt', channelId: 'private-room' } } })
try {
  await presence.start()
  assert.equal(presence.directory().find(agent => agent.name === 'Agent_A').mention, '<@50000>')
  assert.equal(presence.directory().find(agent => agent.name === 'Future_User_Agent').ready, false)
  assert.equal(clients[0].presence.status, 'online'); assert.equal(clients[1].presence.status, 'idle')
  assert(clients.every(client => client.registered))
  assert(presence.status().agents.filter(agent => agent.applicationId).every(agent => agent.ready))
  console.log('PASS generic agent registry uses distinct real-client identities, guild command fixtures and Minecraft-aware online/idle presence')
  const own = message(); clients[0].emit(Events.MessageCreate, own); await tick()
  assert.deepEqual(calls[0], ['30000', 'message-1', 'task', 'Build a wall']); assert.equal(own.replies[0].content, 'Actual tool fixture response')
  const dmFile = { attachment: Buffer.from('explicit DM attachment fixture'), name: 'fixture-dm.png' }
  const dmReceipt = await presence.deliver({ ownerId: 'owner-a', message: 'Progress and screenshot requested in DM', files: [dmFile] })
  assert.equal(deliveries.length, 0); assert.equal(dmReceipt.messageId, 'dm-message')
  assert.equal(dms.at(-1).id, '30000'); assert.equal(dms.at(-1).botId, '50000'); assert.equal(dms.at(-1).payload.files[0], dmFile)
  const other = message({ id: 'other-request', userId: '40000' }); clients[0].emit(Events.MessageCreate, other); await tick()
  assert.equal(calls.length, 1); assert.deepEqual(work[0], ['40000', 'other-request', { agent: 'Agent_A' }, 'Build a wall'])
  clients[0].emit(Events.MessageCreate, message({ id: 'bot-loop', bot: true })); await tick(); assert.equal(calls.length, 1)
  console.log('PASS normal owner DMs delegate existing task execution; other verified humans request work, and bots cannot cause loops')
  const guild = message({ id: 'guild-mention', guildId: '20000', text: '<@50000> Check my supplies' })
  clients[0].emit(Events.MessageCreate, guild); await tick()
  assert.equal(calls.at(-1)[3], 'Check my supplies'); assert.equal(deliveries[0].owner.ownerId, 'owner-a')
  assert.equal(deliveries[0].client, clients[0])
  assert(!guild.replies[0].content.includes('tool fixture')); assert.deepEqual(guild.replies[0].allowedMentions, { parse: [] })
  const before = calls.length
  clients[0].emit(Events.MessageCreate, message({ guildId: '20000', mentioned: false })); await tick()
  deniedMembership = true; clients[0].emit(Events.MessageCreate, message({ id: 'not-member' })); await tick(); deniedMembership = false
  assert.equal(calls.length, before)
  const file = { attachment: Buffer.from('explicit fixture bytes'), name: 'fixture.png' }
  assert.deepEqual(await presence.deliver({ ownerId: 'owner-a', message: 'Native capture supplied by root callback', files: [file] }), {
    delivered: true, applicationId: '50000', messageId: 'actual-fixture-send-receipt', channelId: 'private-room'
  })
  assert.equal(deliveries.at(-1).payload.files[0], file); assert.equal(deliveries.at(-1).client, clients[0])
  useLayoutRelay = false
  await presence.deliver({ ownerId: 'owner-a', message: 'Checked private layout room' })
  assert.equal(roomMessages.at(-1).content, 'Checked private layout room')
  const privateCount = roomMessages.length
  privateRoom.permissionOverwrites.cache.set('90000', overwrite('90000', view))
  await presence.deliver({ ownerId: 'owner-a', message: 'Private DM fallback only' })
  assert.equal(roomMessages.length, privateCount); assert.equal(dms.at(-1).id, '30000'); assert.equal(dms.at(-1).payload.content, 'Private DM fallback only')
  console.log('PASS guild mentions respond privately without public task clutter; membership guards and owner-bound native attachment delivery stay enforced')
  const duplicate = structuredClone(credentials); duplicate.agents.Agent_B.applicationId = '50000'
  const invalid = createAgentPresence({ ...base, credentials: duplicate, clientFactory })
  await assert.rejects(invalid.start(), /DISTINCT_APPLICATIONS/)
  assert(!JSON.stringify(presence.status()).includes('a'.repeat(35)))
  console.log('PASS duplicate application identities fail before login and readiness output contains no bot tokens')
} finally { await presence.close() }
assert(clients.every(client => client.destroyed))
