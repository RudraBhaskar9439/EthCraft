// Injected alias/session/native fixtures: no coin accounts, provider or game writes.
import assert from 'node:assert/strict'
import { createMarketplaceRuntime } from '../../backend/src/discord/marketplace-runtime.mjs'
const ownerId = '11111111-1111-4111-8111-111111111111', playerId = '22222222-2222-4222-8222-222222222222'
const connectionId = '33333333-3333-4333-8333-333333333333', mailboxId = '44444444-4444-4444-8444-444444444444'
const userId = '123456789012345678', queries = [], claims = []
let online = true
const runtime = await createMarketplaceRuntime({ settings: { serverId: 'onchain-fixture' },
  pool: { async query(sql, args) {
    queries.push(sql)
    assert(!sql.includes('ac_game_players') && !sql.includes('ac_game_ledger'), 'Fresh onchain users must not depend on or create Game Coin accounts')
    if (sql.includes('CREATE TABLE')) return { rows: [] }
    assert(sql.includes('FROM ac_discord_minecraft_aliases')); assert.deepEqual(args, [ownerId, 'onchain-fixture'])
    return { rows: [{ player_id: playerId, player_name: 'FreshChainPlayer' }] }
  } },
  identity: { async getOwner(id) { assert.equal(id, userId); return { ownerId, discordUserId: userId, minecraftPlayerId: playerId, privySubject: 'did:privy:explicit-new-owner-fixture' } } },
  agents: { status: () => [], getBot: () => null }, marketplace: {},
  pluginApi: async (path, body) => {
    if (path.startsWith('session?')) return { online, pendingAuthentication: false, principalId: ownerId, playerId, connectionId, authenticationKind: 'discord_approved_local_profile' }
    if (path === 'escrow/mailbox') { assert.deepEqual(body, { ownerId }); return { ownerId, entries: [{ mailboxId, item: 'minecraft:stick', count: 1, state: 'assigned' }] } }
    assert.equal(path, 'escrow/claim'); claims.push(body)
    return { ...body, claimed: true, item: 'minecraft:stick', count: 1 }
  }
})
const selection = await runtime.handleDiscord({ userId, operationId: 'new-owner-mailbox', action: 'claim', args: {} })
assert.deepEqual(selection.mailboxes, [{ mailboxId, item: 'minecraft:stick', count: 1, status: 'assigned' }])
const result = await runtime.handleDiscord({ userId, operationId: 'new-owner-claim', action: 'claim', args: { mailboxId } })
assert.equal(result.receipt.claimed, true); assert.equal(claims[0].ownerId, ownerId); assert.equal(claims[0].playerId, playerId); assert.equal(claims[0].connectionId, connectionId)
online = false
await assert.rejects(runtime.handleDiscord({ userId, operationId: 'offline-claim', action: 'claim', args: { mailboxId } }), /APPROVED_MINECRAFT_SESSION/)
assert.equal(claims.length, 1)
assert(queries.length > 2)
console.log('PASS fresh onchain owner browses and claims native mailbox using only verified alias/session, without a Game Coin account; offline claims refuse')
