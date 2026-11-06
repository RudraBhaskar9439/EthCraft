import { Client, Events, GatewayIntentBits, Partials, ChannelType, PermissionsBitField, SlashCommandBuilder, MessageFlags } from 'discord.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const agentName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/, snowflake = /^[0-9]{5,22}$/
const safeText = value => String(value || '').slice(0, 1900)
const mentions = { parse: [] }
function validateCredentials(value, coordinatorId) {
  if (value?.schema !== 'agentcity.discord-agent-credentials.v1' || !value.agents || Array.isArray(value.agents) || Object.keys(value.agents).some(name => !agentName.test(name))) throw Error('AGENT_CREDENTIALS_INVALID')
  const ids = new Set([coordinatorId]), tokens = new Set()
  for (const credential of Object.values(value.agents)) {
    if (!snowflake.test(credential?.applicationId || '') || ids.has(credential.applicationId) || typeof credential.botToken !== 'string' || credential.botToken.length < 30 || /\s/.test(credential.botToken) || tokens.has(credential.botToken)) throw Error('AGENT_DISTINCT_APPLICATIONS_REQUIRED')
    ids.add(credential.applicationId); tokens.add(credential.botToken)
  }
  return value.agents
}
export async function readAgentCredentials(file, coordinatorId) {
  if (!file) return null
  if (!isAbsolute(file)) throw Error('AGENT_PRIVATE_CREDENTIAL_FILE_REQUIRED')
  let canonical
  try { canonical = await realpath(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const [info, parent] = await Promise.all([stat(canonical), stat(dirname(canonical))])
  if (process.platform === 'win32' || info.uid !== process.getuid() || parent.uid !== process.getuid() || info.mode & 0o077 || parent.mode & 0o077 || !info.isFile() || info.size > 8192) throw Error('AGENT_CREDENTIALS_REQUIRE_PRIVATE_UNIX_STORAGE')
  return validateCredentials(JSON.parse(await readFile(canonical, 'utf8')), coordinatorId)
}

export function createAgentPresence({ settings, agents, identity, executeOwner, createWork, resolveOwner, roomProvider, roomDelivery,
  credentialsFile = settings?.agentCredentialsFile, credentials, clientFactory = options => new Client(options) } = {}) {
  if (!settings?.guildId || !settings.applicationId || !agents?.status || !identity?.getOwner || typeof executeOwner !== 'function' || typeof createWork !== 'function') throw Error('AGENT_PRESENCE_CONFIGURATION_REQUIRED')
  const entries = new Map(), knownOwners = new Map()
  let closed = false, timer, configured = false
  const slotFor = name => agents.status().find(slot => slot.name === name)
  const names = () => [...new Set([...agents.status().map(slot => slot.name), ...entries.keys()])]
  async function verified(entry, userId) {
    const guild = await entry.client.guilds.fetch(settings.guildId)
    const member = await guild.members.fetch(userId)
    if (!member || member.user?.bot) throw Error('VERIFIED_HUMAN_REQUIRED')
    const owner = await identity.getOwner(userId)
    if (!owner?.ownerId || owner.discordUserId !== userId) throw Error('VERIFIED_OWNER_REQUIRED')
    knownOwners.set(owner.ownerId, owner); return owner
  }
  async function room(entry, owner) {
    if (!roomProvider) throw Error('AGENT_PRIVATE_ROOM_UNAVAILABLE')
    const guild = await entry.client.guilds.fetch(settings.guildId), botId = entry.client.user.id
    const permission = PermissionsBitField.Flags
    const verify = channel => {
      if (!channel || channel.guildId !== settings.guildId || channel.type !== ChannelType.GuildText) return false
      const overwrites = [...channel.permissionOverwrites.cache.values()]
      const everyone = overwrites.find(value => value.id === guild.id)
      return !!everyone?.deny.has(permission.ViewChannel) && overwrites.every(value => !value.allow.has(permission.ViewChannel) || [botId, owner.discordUserId, settings.applicationId].includes(value.id)) &&
        [botId, owner.discordUserId].every(id => overwrites.some(value => value.id === id && value.allow.has(permission.ViewChannel)))
    }
    const channel = await roomProvider({ agentName: entry.name, owner, client: entry.client })
    if (!verify(channel)) throw Error('AGENT_ROOM_PERMISSIONS_REQUIRED')
    return channel
  }
  async function sendPrivate(entry, owner, payload) {
    if (entry.origins.get(owner.ownerId) === 'dm') {
      // Keep asynchronous screenshots/progress in the verified conversation that
      // requested them. Failed DMs remain undelivered, never become public posts.
      return (await entry.client.users.fetch(owner.discordUserId)).send({ ...payload, allowedMentions: mentions })
    }
    // Guild administration may inspect private guild channels. Never fall back public.
    if (roomDelivery && slotFor(entry.name)?.ownerId === owner.ownerId) {
      let result
      try { result = await roomDelivery({ slot: slotFor(entry.name), owner, payload: { ...payload, allowedMentions: mentions }, client: entry.client }) }
      catch { /* A failed private room can fall back only to the verified owner's DM. */ }
      if (result?.id) return result
      if (result?.delivered) throw Error('AGENT_DELIVERY_RECEIPT_REQUIRED')
    }
    try { return await (await room(entry, owner)).send({ ...payload, allowedMentions: mentions }) }
    catch { return (await entry.client.users.fetch(owner.discordUserId)).send({ ...payload, allowedMentions: mentions }) }
  }
  async function dispatch(entry, userId, id, text, origin) {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw Error('AGENT_MESSAGE_REQUIRED')
    const owner = await verified(entry, userId), slot = slotFor(entry.name)
    if (origin) entry.origins.set(owner.ownerId, origin)
    if (!slot) return 'This agent is not assigned yet. Open /agents with the coordinator.'
    if (slot.ownerId !== owner.ownerId) return createWork(userId, id, { agent: entry.name }, text.trim())
    return executeOwner(userId, id, 'task', text.trim())
  }
  async function ready(entry, applicationId) {
    if (entry.client.user?.id !== applicationId || entry.client.user.id === settings.applicationId || [...entries.values()].some(other => other !== entry && other.client.user?.id === entry.client.user.id)) throw Error('AGENT_APPLICATION_IDENTITY_MISMATCH')
    const guild = await entry.client.guilds.fetch(settings.guildId)
    const member = await guild.members.fetch(entry.client.user.id)
    if (!member?.user?.bot) throw Error('AGENT_GUILD_MEMBERSHIP_REQUIRED')
    const command = new SlashCommandBuilder().setName('ask').setDescription('Talk to this agent or request work from its owner')
      .addStringOption(option => option.setName('message').setDescription('Task, question or work request').setRequired(true).setMaxLength(500))
    if (closed || entry.abandoned) throw Error('AGENT_PRESENCE_CLOSED')
    await entry.client.application.commands.set([command.toJSON()], settings.guildId)
    if (closed || entry.abandoned) throw Error('AGENT_PRESENCE_CLOSED')
    entry.ready = true; entry.error = null; await refresh()
  }
  async function refresh() {
    for (const entry of entries.values()) if (entry.ready) {
      const slot = slotFor(entry.name)
      entry.client.user.setPresence({ status: slot?.connected ? 'online' : 'idle', activities: [{ name: slot?.connected ? `${slot.mode === 'task' ? 'Working' : 'Waiting'} in Minecraft` : 'Minecraft disconnected', type: 0 }] })
    }
  }
  function attach(entry, applicationId) {
    entry.readiness = new Promise(resolve => { entry.resolveReady = resolve })
    entry.client.once(Events.ClientReady, () => {
      entry.initializing = ready(entry, applicationId).then(() => entry.resolveReady(true)).catch(() => {
        entry.ready = false; entry.error = 'AGENT_LOGIN_OR_GUILD_UNAVAILABLE'; entry.client.destroy(); entry.resolveReady(false)
      })
    })
    entry.client.on(Events.Error, () => { entry.error = 'AGENT_GATEWAY_UNAVAILABLE' })
    entry.client.on(Events.MessageCreate, async message => {
      if (!entry.ready || message.author?.bot || message.guildId && message.guildId !== settings.guildId || message.guildId && !message.mentions.has(entry.client.user)) return
      try {
        const text = message.guildId ? message.content.replace(new RegExp(`<@!?${entry.client.user.id}>`, 'g'), '').trim() : message.content.trim()
        const owner = await verified(entry, message.author.id)
        const response = await dispatch(entry, message.author.id, message.id, text, message.guildId ? 'room' : 'dm')
        if (!message.guildId) await message.reply({ content: safeText(response), allowedMentions: mentions })
        else {
          const sent = await sendPrivate(entry, owner, { content: safeText(response) })
          if (sent.channelId !== message.channelId) await message.reply({ content: 'Reply sent privately. Continue in your agent room or DM this bot.', allowedMentions: mentions })
        }
      } catch { await message.reply({ content: 'Finish /start with the coordinator and verify server membership. Only your own agent accepts controls; other agents accept work requests.', allowedMentions: mentions }).catch(() => {}) }
    })
    entry.client.on(Events.InteractionCreate, async interaction => {
      if (!entry.ready || !interaction.isChatInputCommand() || interaction.commandName !== 'ask' || interaction.user.bot || interaction.guildId && interaction.guildId !== settings.guildId) return
      try {
        await interaction.deferReply(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {})
        const response = await dispatch(entry, interaction.user.id, interaction.id, interaction.options.getString('message', true), interaction.guildId ? 'room' : 'dm')
        await interaction.editReply({ content: safeText(response), allowedMentions: mentions })
      } catch { await interaction.editReply({ content: 'Finish /start and verify your server membership before asking this agent.', allowedMentions: mentions }).catch(() => {}) }
    })
  }
  return {
    async start() {
      if (closed) throw Error('AGENT_PRESENCE_CLOSED')
      if (settings.organizedServer === false) return this.status()
      if (configured) return this.status()
      const loaded = credentials ? validateCredentials(credentials, settings.applicationId) : await readAgentCredentials(credentialsFile, settings.applicationId)
      if (!loaded) return this.status()
      configured = true
      for (const [name, credential] of Object.entries(loaded)) {
        const client = clientFactory({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] })
        const entry = { name, client, applicationId: credential.applicationId, ready: false, error: null, origins: new Map() }; entries.set(name, entry); attach(entry, credential.applicationId)
        let deadline
        try {
          await Promise.race([Promise.resolve(client.login(credential.botToken)).then(() => entry.readiness),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('AGENT_READY_TIMEOUT')), 30000) })])
        } catch { entry.abandoned = true; entry.ready = false; entry.error = 'AGENT_LOGIN_OR_GUILD_UNAVAILABLE'; client.destroy(); entry.resolveReady(false) }
        finally { clearTimeout(deadline) }
      }
      timer = setInterval(() => { refresh().catch(() => {}) }, 10000); timer.unref()
      return this.status()
    },
    status() { return { configured, agents: names().map(name => { const entry = entries.get(name); return { name, applicationId: entry?.applicationId || null, ready: entry?.ready === true, state: entry?.error || (entry?.ready ? 'ready' : 'provisioning_required') } }) } },
    directory() { return names().map(name => { const entry = entries.get(name), slot = slotFor(name); return { name, slotName: name, applicationId: entry?.applicationId || null, ready: entry?.ready === true, ownerId: slot?.ownerId || null, discordUserId: entry?.ready ? entry.client.user.id : null, mention: entry?.ready ? `<@${entry.client.user.id}>` : null, connected: slot?.connected === true } }) },
    refresh,
    async deliver({ ownerId, message, files = [] }) {
      const slot = agents.status().find(value => value.ownerId === ownerId), entry = slot && entries.get(slot.name)
      if (!entry?.ready) return { delivered: false, reason: 'agent_bot_pending' }
      const owner = resolveOwner ? await resolveOwner(ownerId) : knownOwners.get(ownerId)
      if (!owner || owner.ownerId !== ownerId || !snowflake.test(owner.discordUserId || '')) return { delivered: false, reason: 'verified_recipient_required' }
      const actualOwner = await verified(entry, owner.discordUserId)
      if (actualOwner.ownerId !== ownerId) return { delivered: false, reason: 'verified_recipient_required' }
      const sent = await sendPrivate(entry, actualOwner, { content: safeText(message), ...(files.length ? { files } : {}) })
      if (!sent?.id) throw Error('AGENT_DELIVERY_RECEIPT_REQUIRED')
      return { delivered: true, applicationId: entry.applicationId, messageId: sent.id, channelId: sent.channelId || sent.channel?.id || null }
    },
    async close() { closed = true; clearInterval(timer); for (const entry of entries.values()) { entry.ready = false; entry.client.destroy() } }
  }
}
