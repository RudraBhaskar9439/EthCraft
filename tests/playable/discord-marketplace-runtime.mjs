// Explicit identity/native/core fixtures. No real economy, provider or game writes.
import assert from 'node:assert/strict'
import { createMarketplaceRuntime } from '../../backend/src/discord/marketplace-runtime.mjs'
const ownerId = '11111111-1111-4111-8111-111111111111', accountId = '22222222-2222-4222-8222-222222222222'
const botId = '33333333-3333-4333-8333-333333333333', strangerId = '44444444-4444-4444-8444-444444444444'
const connectionId = '55555555-5555-4555-8555-555555555555', stockId = '66666666-6666-4666-8666-666666666666'
const owner = { ownerId, discordUserId: '123456789012345678', ownerName: 'LinkedPlayer', minecraftPlayerId: accountId, privySubject: 'did:privy:explicit-identity-fixture' }
const authorities = new Map(), revisions = new Map(), native = [], queries = [], slots = [{ name: 'Agent_One', ownerId, connected: true, mode: 'wait', tasks: [] }]
let online = true, pending = false, missingAccount = false, marketOptions, listing, prepared = 0
let nativeStatus = { known: false }, failReserveBeforeIntent = false, enforceExpiry = false, liveConnectionId = connectionId, nativeEffects = 0
const pool = { async query(sql, args = []) {
  queries.push(sql)
  if (sql.includes('CREATE TABLE')) return { rows: [] }
  if (sql.includes('FROM ac_discord_minecraft_aliases')) return { rows: !missingAccount && args[0] === ownerId ? [{ player_id: accountId, player_name: owner.ownerName, account_id: accountId, account_name: owner.ownerName }] : [] }
  if (sql.startsWith('INSERT INTO ac_discord_market_authority_revisions')) { if (!revisions.has(args[0])) revisions.set(args[0], { principal_id: args[2], payload: structuredClone(args[3]) }); return { rows: [] } }
  if (sql.startsWith('SELECT principal_id,payload FROM ac_discord_market_authority_revisions')) return { rows: revisions.has(args[0]) ? [revisions.get(args[0])] : [] }
  if (sql.startsWith('INSERT INTO ac_discord_market_authorities')) { if (!authorities.has(args[0])) authorities.set(args[0], { principal_id: args[1], payload: structuredClone(args[2]) }); return { rows: [] } }
  if (sql.startsWith('SELECT principal_id,payload')) return { rows: authorities.has(args[0]) ? [authorities.get(args[0])] : [] }
  throw Error('Unexpected fixture SQL')
} }
const identity = { async getOwner(id) { if (id !== owner.discordUserId) throw Error('UNVERIFIED'); return structuredClone(owner) }, async lookupMinecraft({ playerId }) { assert.equal(playerId, accountId); return owner } }
const agents = { status: () => slots, getBot: id => id === ownerId ? { username: 'Agent_One', player: { uuid: botId }, inventory: { items: () => [{ name: 'oak_planks', count: 4 }] } } : null }
async function pluginApi(path, body) {
  native.push({ path, body: structuredClone(body) })
  if (path.startsWith('session?')) return { online, pendingAuthentication: pending, principalId: ownerId, playerId: accountId, connectionId: liveConnectionId, authenticationKind: 'discord_approved_local_profile' }
  if (path === 'escrow/status') return structuredClone(nativeStatus)
  if (path === 'escrow/authorize') { if (enforceExpiry && body.expiresAtMs <= Date.now()) throw Error('NATIVE_AUTHORITY_EXPIRED'); return { authorized: true } }
  if (path === 'escrow/reserve') {
    if (failReserveBeforeIntent) throw Error('Fixture transport failed before native intent acceptance')
    if (!nativeStatus.pending) nativeEffects++
    return { ...body, escrowed: true, custodyId: body.listingId, fingerprint: 'f'.repeat(64) }
  }
  if (path === 'escrow/mailbox') return { ownerId, entries: [{ mailboxId: listing.listingId, item: listing.item, count: listing.count, state: 'assigned' }] }
  if (path === 'escrow/claim') return { ...body, claimed: true }
  throw Error('Unexpected native fixture call')
}
async function marketFactory(options) {
  marketOptions = options
  return {
    async list() { return [] },
    async prepareListing(input) {
      prepared++; assert.equal(input.sellerId, ownerId); assert.equal(input.sellerAccountId, accountId)
      listing = { ...input, listingId: input.operationId, stockOperationId: stockId, item: 'minecraft:oak_planks', termsDigest: 'a'.repeat(64), state: 'awaiting_stock' }
      return structuredClone(listing)
    },
    async getListing() { return structuredClone(listing) },
    async getPurchase() { throw Error('GAME_MARKET_PURCHASE_OWNER_REQUIRED') },
    async confirmListing() {
      if (listing.state === 'open') return structuredClone(listing)
      const request = { action: 'list', principalId: ownerId, accountId, ...listing }
      assert.equal(await options.authorize({ ...request, sourceId: strangerId }), false)
      assert.equal(await options.authorize(request), true)
      listing.state = 'stock_pending'; return structuredClone(listing)
    },
    async confirmStock({ receipt }) {
      assert.equal(receipt.escrowed, true)
      assert.equal(receipt.sourceId, listing.sourceId); assert.equal(receipt.sellerAccountId, accountId)
      listing.state = 'open'; return structuredClone(listing)
    }
  }
}
const runtime = await createMarketplaceRuntime({ pool, identity, settings: { serverId: 'fixture-server' }, agents, pluginApi, marketplace: marketFactory, allowLegacyGameCoinsFixture: true,
  economy: { handle() { throw Error('Starter grant path must never be used') } } })
assert.equal(await marketOptions.resolveAccount({ principalId: ownerId }), accountId)
assert.equal(await marketOptions.resolveAccount({ principalId: strangerId }), null)
assert.equal(await marketOptions.authorize({ action: 'list', principalId: ownerId, accountId, confirmed: true }), false)
await runtime.handleDiscord({ userId: 'unverified', operationId: 'public-browse', action: 'browse' })
missingAccount = true
await assert.rejects(runtime.handleDiscord({ userId: owner.discordUserId, operationId: 'no-account', action: 'list', args: { source: 'agent' } }), /EXISTING_MINECRAFT_ACCOUNT/)
missingAccount = false
assert(!queries.some(sql => /INSERT INTO ac_game_players|starter_grant|ac_game_ledger/.test(sql)))
console.log('PASS canonical verified Discord principal resolves only its existing actual Minecraft coin account; no starter grant or boolean-only financial authority')

const call = (operationId, action, args = {}, extra = {}) => runtime.handleDiscord({ userId: owner.discordUserId, operationId, action, args, ...extra })
await assert.rejects(call('forged-source', 'list', { source: 'agent', sourceId: strangerId, item: 'oak_planks', count: 4, price: '8' }), /ARGUMENTS/)
const preview = await call('agent-preview', 'list', { source: 'agent', agentId: 'Agent_One', item: 'oak_planks', count: 4, price: '8' }, { confirmed: true })
assert.equal(preview.listing.sourceId, botId); assert.equal(preview.confirmation.action, 'confirm_listing')
assert.equal(native.filter(call => call.path === 'escrow/reserve').length, 0)
slots[0].tasks = [{ status: 'blocked' }]
await assert.rejects(call('busy-agent', 'list', { source: 'agent', item: 'oak_planks', count: 4, price: '8' }), /RECONCILE_AGENT_TASK/)
slots[0].tasks = []
await assert.rejects(call('foreign-agent', 'list', { source: 'agent', agentId: 'OtherAgent', item: 'oak_planks', count: 4, price: '8' }), /OWN_AGENT/)
console.log('PASS listing always previews exact total-price terms and resolves native owned agent UUID; forged inventories, foreign agents and unfinished physical tasks refuse before effects')

online = false
await assert.rejects(call('offline-human', 'list', { source: 'player', item: 'oak_planks', count: 4, price: '8' }), /APPROVED_MINECRAFT_SESSION/)
const result = await call('explicit-list-confirm', 'confirm_listing', { listingId: preview.listing.listingId })
assert.equal(result.listing.state, 'open')
const authority = native.find(call => call.path === 'escrow/authorize').body
assert.equal(authority.sellerId, ownerId); assert.equal(authority.ownerPlayerId, accountId); assert.equal(authority.sourceId, botId)
assert.equal(authority.sourceKind, 'agent_inventory'); assert.equal(authority.confirmed, true)
assert.equal(authority.connectionId, undefined)
await call('same-listing-retry', 'confirm_listing', { listingId: preview.listing.listingId })
assert.equal(native.filter(call => call.path === 'escrow/reserve').length, 1)
const originalSeller = listing.sellerId; listing.sellerId = strangerId
await assert.rejects(call('cross-owner-listing', 'confirm_listing', { listingId: listing.listingId }), /LISTING_OWNER/)
listing.sellerId = originalSeller
console.log('PASS explicit owner confirmation scopes exact native stock authority while Minecraft is offline; receipt replay does not reserve twice and other owners cannot confirm')

const mailbox = await call('browse-owned-mailbox', 'claim')
assert.equal(mailbox.mailboxes[0].mailboxId, listing.listingId)
await assert.rejects(call('offline-claim', 'claim', { mailboxId: listing.listingId }), /APPROVED_MINECRAFT_SESSION/)
online = true
await assert.rejects(runtime.handleGame({ playerId: accountId, connectionId: strangerId, operationId: 'stale-session', args: ['list', 'oak_planks', '4', '8', 'player'] }), /APPROVED_MINECRAFT_SESSION/)
pending = true
await assert.rejects(call('unapproved-human', 'list', { source: 'player', item: 'oak_planks', count: 4, price: '8' }), /APPROVED_MINECRAFT_SESSION/)
pending = false
await runtime.handleGame({ playerId: accountId, connectionId, operationId: 'actual-bound-game-event', args: ['list', 'oak_planks', '4', '8', 'player'] })
assert.equal(listing.sellerId, ownerId); assert.equal(listing.sourceId, accountId)
const claimed = await call('approved-claim', 'claim', { mailboxId: listing.listingId })
assert.equal(claimed.receipt.playerId, accountId)
assert.equal(prepared, 2)
console.log('PASS player inventory and mailbox claims require the exact current approved connection; generic game commands resolve canonical ownership and preserve Minecraft ledger UUID')

const realNow = Date.now
let clock = realNow()
try {
  Date.now = () => clock; enforceExpiry = true
  const freshPreview = await call('pre-intent-renewal-preview', 'list', { source: 'player', item: 'oak_planks', count: 4, price: '8' })
  failReserveBeforeIntent = true
  await assert.rejects(call('first-explicit-consent', 'confirm_listing', { listingId: freshPreview.listing.listingId }), /before native intent/)
  const oldAuthority = structuredClone(native.filter(value => value.path === 'escrow/authorize').at(-1).body)
  const oldRevision = structuredClone(revisions.get(oldAuthority.authorityId))
  clock += 360000
  await assert.rejects(call('first-explicit-consent', 'confirm_listing', { listingId: freshPreview.listing.listingId }), /AUTHORITY_EXPIRED/)
  assert.deepEqual(revisions.get(oldAuthority.authorityId), oldRevision)
  liveConnectionId = '88888888-8888-4888-8888-888888888888'
  failReserveBeforeIntent = false
  const effectsBeforeRenewal = nativeEffects
  await call('new-human-confirm-after-reconnect', 'confirm_listing', { listingId: freshPreview.listing.listingId })
  const renewed = native.filter(value => value.path === 'escrow/authorize').at(-1).body
  assert.notEqual(renewed.authorityId, oldAuthority.authorityId)
  assert.equal(renewed.operationId, oldAuthority.operationId); assert.equal(renewed.termsDigest, oldAuthority.termsDigest)
  assert.equal(renewed.connectionId, liveConnectionId); assert(renewed.expiresAtMs > clock)
  assert.deepEqual(revisions.get(oldAuthority.authorityId), oldRevision); assert.equal(nativeEffects, effectsBeforeRenewal + 1)
  console.log('PASS expired same-consent retry never extends authority; a new explicit owner confirmation before any native intent appends fresh authority for the same stock operation after reconnect')

  listing.state = 'stock_pending'; online = false
  const originalIntent = { operationId: listing.stockOperationId, listingId: listing.listingId, sellerId: ownerId,
    sellerAccountId: accountId, sourceId: listing.sourceId, sourceKind: listing.sourceKind, item: listing.item,
    count: listing.count, termsDigest: listing.termsDigest, authorityId: oldAuthority.authorityId }
  nativeStatus = { known: true, pending: true, receipt: originalIntent }
  const grantsBefore = native.filter(value => value.path === 'escrow/authorize').length, effectsBeforeReconcile = nativeEffects, revisionsBefore = revisions.size
  await call('explicit-pending-stock-reconcile', 'confirm_listing', { listingId: listing.listingId })
  assert.deepEqual(native.filter(value => value.path === 'escrow/reserve').at(-1).body, originalIntent)
  assert.equal(native.filter(value => value.path === 'escrow/authorize').length, grantsBefore)
  assert.equal(revisions.size, revisionsBefore); assert.equal(nativeEffects, effectsBeforeReconcile)
  listing.state = 'stock_pending'
  nativeStatus = { known: true, pending: false, receipt: { ...originalIntent, escrowed: true, custodyId: listing.listingId, fingerprint: 'f'.repeat(64) } }
  const reservesBefore = native.filter(value => value.path === 'escrow/reserve').length
  await call('completed-native-receipt-replay', 'confirm_listing', { listingId: listing.listingId })
  assert.equal(native.filter(value => value.path === 'escrow/reserve').length, reservesBefore)
  assert.equal(native.filter(value => value.path === 'escrow/authorize').length, grantsBefore)
  console.log('PASS pending native intent reconciles with its original expired authority without reauthorization or source-session checks; completed custody receipts bypass reserve entirely')
} finally { Date.now = realNow }
