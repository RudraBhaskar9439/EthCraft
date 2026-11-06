import { ChannelType, PermissionFlagsBits as P } from 'discord.js'

const snowflake = /^[0-9]{5,22}$/
const slot = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const fail = code => { throw Object.assign(Error(code), { code }) }
const required = ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages']
const writeBits = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads
const privateBits = P.ViewChannel | writeBits
const values = collection => [...collection.values()]
const ids = input => [...new Set(input.map(value => {
  if (!snowflake.test(value || '')) fail('DISCORD_LAYOUT_MEMBER_ID_INVALID')
  return value
}))].sort()

// Discord REST calls are deliberately outside database transactions. A durable
// creating marker prevents an uncertain create from being silently repeated.
export function createDiscordServerLayout({ pool, guild, coordinatorBotId, serverId = 'agentcity-playable' }) {
  if (!pool || !guild || !snowflake.test(coordinatorBotId || '') || !/^[A-Za-z0-9_.:-]{1,128}$/.test(serverId)) fail('DISCORD_LAYOUT_CONFIGURATION_INVALID')
  async function initialize() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ac_discord_layout (
      server_id TEXT NOT NULL, guild_id TEXT NOT NULL, resource_key TEXT NOT NULL,
      channel_id TEXT, state TEXT NOT NULL CHECK(state IN ('creating','ready')),
      member_ids JSONB NOT NULL DEFAULT '[]', pending_member_ids JSONB,
      PRIMARY KEY(server_id,guild_id,resource_key))`)
    await pool.query('ALTER TABLE ac_discord_layout ADD COLUMN IF NOT EXISTS pending_member_ids JSONB')
  }
  async function context(memberIds = []) {
    const me = await guild.members.fetch(coordinatorBotId)
    const missingPermissions = required.filter(name => !me.permissions.has(P[name]))
    if (missingPermissions.length) return { ok: false, missingPermissions }
    const roles = await guild.roles.fetch()
    if (roles.size + ids([coordinatorBotId, ...memberIds]).length > 100) fail('DISCORD_LAYOUT_OVERWRITE_LIMIT_EXCEEDED')
    for (const memberId of ids(memberIds)) await guild.members.fetch(memberId)
    return { ok: true, missingPermissions: [], roles, me, administratorVisibility: true }
  }
  function agentMembers(agent) {
    if (!slot.test(agent.slotName || '')) fail('DISCORD_LAYOUT_SLOT_INVALID')
    return ids([agent.ownerDiscordId, coordinatorBotId, ...(agent.agentBotId ? [agent.agentBotId] : [])])
  }
  async function preflight({ agents = [] } = {}) {
    if (!Array.isArray(agents) || agents.length > 50) fail('DISCORD_LAYOUT_AGENT_BATCH_INVALID')
    const all = agents.flatMap(agentMembers)
    if (new Set(agents.map(agent => agent.slotName)).size !== agents.length) fail('DISCORD_LAYOUT_DUPLICATE_SLOT')
    const result = await context(all)
    if (result.ok) {
      for (const agent of agents) {
        const owner = await guild.members.fetch(agent.ownerDiscordId)
        if (owner.user?.bot) fail('DISCORD_LAYOUT_OWNER_MUST_BE_HUMAN_ACCOUNT')
        if (agent.agentBotId && !(await guild.members.fetch(agent.agentBotId)).user?.bot) fail('DISCORD_LAYOUT_AGENT_MUST_BE_BOT_ACCOUNT')
      }
    }
    return result.ok ? { ok: true, missingPermissions: [], administratorVisibility: true } : result
  }
  function overwrites(roles, members, kind) {
    const result = values(roles).map(role => ({ id: role.id, type: 0,
      allow: kind === 'chat' && role.id === guild.id ? P.ViewChannel | P.SendMessages | P.ReadMessageHistory : 0n,
      deny: kind === 'private' ? privateBits : kind === 'board' ? writeBits : 0n }))
    if (kind !== 'private') {
      const everyone = result.find(role => role.id === guild.id)
      if (!everyone) fail('DISCORD_LAYOUT_EVERYONE_ROLE_MISSING')
      everyone.allow |= P.ViewChannel | P.ReadMessageHistory
    }
    for (const id of members) result.push({ id, type: 1, allow: P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.AttachFiles | P.EmbedLinks, deny: 0n })
    return result
  }
  async function locked(operation) {
    const client = await pool.connect()
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['discord-layout:' + serverId + ':' + guild.id])
      return await operation(client)
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['discord-layout:' + serverId + ':' + guild.id]) } finally { client.release() }
    }
  }
  async function managed(client, { key, name, type, parent = null, members = [], kind, roles }) {
    const args = [serverId, guild.id, key]
    const row = (await client.query('SELECT * FROM ac_discord_layout WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3', args)).rows[0]
    const pendingMigration = row?.channel_id && row.state === 'creating' && JSON.stringify(row.pending_member_ids) === JSON.stringify(members)
    if (row && row.state !== 'ready' && !pendingMigration) fail('DISCORD_LAYOUT_UNCERTAIN_CREATE_REQUIRES_OPERATOR_REVIEW')
    const permissionOverwrites = overwrites(roles, members, kind)
    let channel
    if (row) {
      // Never adopt by name, delete, purge, or touch an unrelated channel.
      channel = await guild.channels.fetch(row.channel_id)
      if (!channel || channel.guildId !== guild.id || channel.type !== type) fail('DISCORD_LAYOUT_MANAGED_CHANNEL_MISSING_OR_CHANGED')
      if (!pendingMigration && JSON.stringify(row.member_ids) !== JSON.stringify(members)) fail('DISCORD_LAYOUT_MEMBERSHIP_CHANGE_REQUIRES_OPERATOR_REVIEW')
      await channel.edit({ name, parent, permissionOverwrites, reason: 'Reconcile AgentCity managed channel' })
      if (pendingMigration) {
        await validatePrivateAcl(channel.id, members)
        await client.query(`UPDATE ac_discord_layout SET state='ready',member_ids=$4::jsonb,pending_member_ids=NULL WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3`, [...args, JSON.stringify(members)])
      }
    } else {
      await client.query(`INSERT INTO ac_discord_layout(server_id,guild_id,resource_key,state,member_ids) VALUES($1,$2,$3,'creating',$4::jsonb)`, [...args, JSON.stringify(members)])
      channel = await guild.channels.create({ name, type, parent, permissionOverwrites, reason: 'Create AgentCity managed channel' })
      await client.query(`UPDATE ac_discord_layout SET state='ready',channel_id=$4 WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3`, [...args, channel.id])
    }
    if (kind === 'private') await validatePrivateAcl(channel.id, members)
    return channel.id
  }
  async function reconcile({ agents = [] } = {}) {
    const check = await preflight({ agents })
    if (!check.ok) return check
    const ctx = await context(agents.flatMap(agentMembers))
    if (!ctx.ok) return ctx
    return locked(async client => {
      const channels = {}
      for (const [key, name] of [['start', 'START HERE'], ['community', 'COMMUNITY'], ['workspace', 'WORKSPACE']]) {
        channels[key] = await managed(client, { key: 'category:' + key, name, type: ChannelType.GuildCategory, kind: 'chat', roles: ctx.roles, members: [coordinatorBotId] })
      }
      for (const [name, parent, kind] of [['welcome','start','board'],['agent-directory','start','board'],['jobs','workspace','board'],['marketplace','workspace','board'],['transactions','workspace','board'],['general-chat','community','chat']]) {
        channels[name] = await managed(client, { key: 'public:' + name, name, type: ChannelType.GuildText, parent: channels[parent], kind, roles: ctx.roles, members: [coordinatorBotId] })
      }
      for (const agent of agents) channels[agent.slotName] = await managed(client, { key: 'agent:' + agent.slotName, name: agent.slotName.toLowerCase() + '-private', type: ChannelType.GuildText, parent: channels.workspace, kind: 'private', roles: ctx.roles, members: agentMembers(agent) })
      return { ok: true, channels, welcomeId: channels.welcome, agentDirectoryId: channels['agent-directory'], jobsId: channels.jobs,
        transactionsId: channels.transactions, marketplaceId: channels.marketplace, generalId: channels['general-chat'],
        agentRooms: Object.fromEntries(agents.map(agent => [agent.slotName, channels[agent.slotName]])), administratorVisibility: true }
    })
  }
  async function privateJobRoom({ jobId, participantDiscordIds, agentBotIds = [] }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId || '') || !Array.isArray(participantDiscordIds) || !participantDiscordIds.length) fail('DISCORD_LAYOUT_JOB_INVALID')
    const members = ids([...participantDiscordIds, ...agentBotIds, coordinatorBotId]), ctx = await context(members)
    if (!ctx.ok) return ctx
    for (const id of agentBotIds) if (!(await guild.members.fetch(id)).user?.bot) fail('DISCORD_LAYOUT_AGENT_MUST_BE_BOT_ACCOUNT')
    return locked(async client => {
      const parent = (await client.query(`SELECT channel_id FROM ac_discord_layout WHERE server_id=$1 AND guild_id=$2 AND resource_key='category:workspace' AND state='ready'`, [serverId, guild.id])).rows[0]
      if (!parent) fail('DISCORD_LAYOUT_WORKSPACE_REQUIRED')
      const channelId = await managed(client, { key: 'job:' + jobId, name: 'job-' + jobId.toLowerCase().slice(0,70), type: ChannelType.GuildText, parent: parent.channel_id, members, kind: 'private', roles: ctx.roles })
      return { ok: true, channelId, administratorVisibility: true }
    })
  }
  async function assertPrivateRoom({ channelId, memberIds }) {
    const members = ids(memberIds), row = (await pool.query(`SELECT member_ids FROM ac_discord_layout WHERE server_id=$1 AND guild_id=$2 AND channel_id=$3 AND state='ready' AND (resource_key LIKE 'agent:%' OR resource_key LIKE 'job:%')`, [serverId, guild.id, channelId])).rows[0]
    if (!row || JSON.stringify(row.member_ids) !== JSON.stringify(members) || !members.includes(coordinatorBotId)) fail('DISCORD_LAYOUT_PRIVATE_AUTHORITY_MISMATCH')
    return validatePrivateAcl(channelId, members)
  }
  async function validatePrivateAcl(channelId, members) {
    const channel = await guild.channels.fetch(channelId, { force: true }), roles = await guild.roles.fetch()
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) fail('DISCORD_LAYOUT_PRIVATE_CHANNEL_INVALID')
    const entries = channel.permissionOverwrites.cache
    for (const role of values(roles)) {
      const entry = entries.get(role.id)
      if (!entry || entry.type !== 0 || (entry.deny.bitfield & privateBits) !== privateBits || (entry.allow.bitfield & privateBits)) fail('DISCORD_LAYOUT_PRIVATE_ACL_UNSAFE')
    }
    for (const entry of values(entries)) {
      if (entry.type === 1 && !members.includes(entry.id)) fail('DISCORD_LAYOUT_PRIVATE_ACL_UNSAFE')
    }
    for (const member of members) {
      const entry = entries.get(member)
      if (!entry || entry.type !== 1 || !entry.allow.has(P.ViewChannel | P.SendMessages)) fail('DISCORD_LAYOUT_PRIVATE_ACL_UNSAFE')
    }
    return channel
  }
  async function sendPrivate({ channelId, memberIds, payload }) {
    const channel = await assertPrivateRoom({ channelId, memberIds })
    return channel.send({ ...payload, allowedMentions: { parse: [] } })
  }
  async function getRoom(slotName) {
    if (!slot.test(slotName || '')) fail('DISCORD_LAYOUT_SLOT_INVALID')
    const row = (await pool.query(`SELECT channel_id,member_ids FROM ac_discord_layout WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3 AND state='ready'`, [serverId, guild.id, 'agent:' + slotName])).rows[0]
    return row ? { channelId: row.channel_id, memberIds: row.member_ids, administratorVisibility: true } : null
  }
  // Trusted operator/runtime registry supplies the expected bot ID. This only
  // adds a real bot to an existing owner+coordinator room; it never changes owner.
  async function addAgentBot({ slotName, ownerDiscordId, agentBotId }) {
    if (!slot.test(slotName || '')) fail('DISCORD_LAYOUT_SLOT_INVALID')
    const members = ids([ownerDiscordId, coordinatorBotId, agentBotId])
    if (members.length !== 3) fail('DISCORD_LAYOUT_AGENT_BOT_MUST_BE_DISTINCT')
    const ctx = await context(members)
    if (!ctx.ok) return ctx
    if ((await guild.members.fetch(ownerDiscordId)).user?.bot || !(await guild.members.fetch(agentBotId)).user?.bot) fail('DISCORD_LAYOUT_AGENT_BOT_MEMBERSHIP_INVALID')
    return locked(async client => {
      const args = [serverId, guild.id, 'agent:' + slotName]
      const row = (await client.query('SELECT * FROM ac_discord_layout WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3', args)).rows[0]
      const original = ids([ownerDiscordId, coordinatorBotId])
      if (!row || !row.channel_id || row.state !== 'ready') fail('DISCORD_LAYOUT_AGENT_ROOM_NOT_READY')
      if (JSON.stringify(row.member_ids) === JSON.stringify(members)) {
        await validatePrivateAcl(row.channel_id, members)
        return { ok: true, channelId: row.channel_id, memberIds: members, administratorVisibility: true }
      }
      if (JSON.stringify(row.member_ids) !== JSON.stringify(original)) fail('DISCORD_LAYOUT_MEMBERSHIP_CHANGE_REQUIRES_OPERATOR_REVIEW')
      const channel = await validatePrivateAcl(row.channel_id, original)
      await client.query(`UPDATE ac_discord_layout SET state='creating',pending_member_ids=$4::jsonb WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3`, [...args, JSON.stringify(members)])
      await channel.edit({ permissionOverwrites: overwrites(ctx.roles, members, 'private'), reason: 'Add registered AgentCity bot; preserve room owner' })
      await validatePrivateAcl(row.channel_id, members)
      await client.query(`UPDATE ac_discord_layout SET state='ready',member_ids=$4::jsonb,pending_member_ids=NULL WHERE server_id=$1 AND guild_id=$2 AND resource_key=$3`, [...args, JSON.stringify(members)])
      return { ok: true, channelId: row.channel_id, memberIds: members, administratorVisibility: true }
    })
  }
  return { initialize, preflight, reconcile, privateJobRoom, getRoom, assertPrivateRoom, sendPrivate, addAgentBot }
}
