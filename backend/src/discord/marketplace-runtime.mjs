import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createCoinRetirement } from '../playable/coin-retirement.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = value => { const h = createHash('sha256').update(String(value)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v)
const fail = message => { throw Error(message) }
const permitted = (args, keys) => {
  if (!args || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) fail('MARKET_ARGUMENTS_INVALID')
}

// This adapter accepts authenticated human commands from the coordinator/plugin,
// never model tool dispatch. Physical delegation grants are deliberately unused.
export async function createMarketplaceRuntime({ pool, identity, settings, agents, pluginApi, economy, marketplace, allowLegacyGameCoinsFixture = false } = {}) {
  if (!pool?.query || !identity?.getOwner || !settings?.serverId || !agents?.status || !agents?.getBot || typeof pluginApi !== 'function') fail('MARKET_RUNTIME_CONFIGURATION_REQUIRED')
  void economy // Existing account rows are read directly: onboarding would mint a starter grant.
  const retirement = allowLegacyGameCoinsFixture ? null : createCoinRetirement({ pool })
  const consent = new AsyncLocalStorage()
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_discord_market_authorities (
    stock_operation_id uuid PRIMARY KEY, principal_id uuid NOT NULL, payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`)
  // Append-only explicit consent revisions. Older authority payloads remain intact.
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_discord_market_authority_revisions (
    authority_id uuid PRIMARY KEY, stock_operation_id uuid NOT NULL, principal_id uuid NOT NULL,
    payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`)
  async function account(principalId) {
    if (!UUID.test(principalId || '')) fail('MARKET_VERIFIED_PRINCIPAL_REQUIRED')
    const rows = (await pool.query(`SELECT a.player_id,a.player_name
      FROM ac_discord_minecraft_aliases a
      WHERE a.principal_id=$1 AND a.server_id=$2`, [principalId, settings.serverId])).rows
    const value = rows.length === 1 ? rows[0] : null
    if (!value || !UUID.test(value.player_id)) fail('MARKET_EXISTING_MINECRAFT_ACCOUNT_REQUIRED')
    return { playerId: value.player_id.toLowerCase(), playerName: value.player_name }
  }
  async function authorize(request) {
    const scope = consent.getStore()
    if (!scope || scope.principalId !== request.principalId || scope.accountId !== request.accountId || scope.action !== request.action) return false
    if (scope.listingId && scope.listingId !== request.listingId || scope.purchaseId && scope.purchaseId !== request.purchaseId) return false
    for (const key of ['item', 'count', 'price', 'sourceId', 'sourceKind', 'termsDigest', 'quoteDigest']) {
      if (scope.terms?.[key] !== undefined && String(scope.terms[key]) !== String(request[key])) return false
    }
    return true
  }
  const factory = typeof marketplace === 'function' ? marketplace : !marketplace ? (await import('../playable/game-marketplace.mjs')).createGameMarketplace : null
  const market = factory ? await factory({ pool, authorize, allowLegacyGameCoinsFixture, resolveAccount: async ({ principalId }) => { try { return (await account(principalId)).playerId } catch { return null } } }) : marketplace
  async function ownerFor(userId) {
    const owner = await identity.getOwner(userId)
    if (!owner || owner.discordUserId !== userId || !UUID.test(owner.ownerId || '') || !owner.privySubject) fail('MARKET_VERIFIED_HUMAN_REQUIRED')
    const linked = await account(owner.ownerId)
    if (!owner.minecraftPlayerId || owner.minecraftPlayerId.toLowerCase() !== linked.playerId) fail('MARKET_MINECRAFT_ALIAS_REQUIRED')
    return { ...owner, account: linked }
  }
  async function session(owner, expectedConnection) {
    const current = await pluginApi('session?playerId=' + encodeURIComponent(owner.account.playerId))
    if (current.online !== true || current.pendingAuthentication !== false || current.principalId !== owner.ownerId || !UUID.test(current.connectionId || '') || !current.authenticationKind || current.authenticationKind === 'unverified_local_connection' ||
      current.playerId && current.playerId.toLowerCase() !== owner.account.playerId || expectedConnection && current.connectionId !== expectedConnection) fail('MARKET_CURRENT_APPROVED_MINECRAFT_SESSION_REQUIRED')
    return current
  }
  function ownedAgent(owner, agentId) {
    const slot = agents.status().find(value => value.ownerId === owner.ownerId && (!agentId || value.name === agentId))
    if (!slot || !slot.connected) fail('MARKET_CONNECTED_OWN_AGENT_REQUIRED')
    if (slot.mode === 'task' || slot.tasks?.some(task => !['complete', 'cancelled'].includes(task.status)) || agents.tools?.unfinished?.(owner.ownerId) || slot.workflow && slot.workflow.status !== 'complete') fail('MARKET_FINISH_OR_RECONCILE_AGENT_TASK_FIRST')
    const bot = agents.getBot(owner.ownerId), sourceId = bot?.player?.uuid || bot?.entity?.uuid || bot?._client?.uuid
    if (!UUID.test(sourceId || '') || bot?.username !== slot.name || typeof bot.inventory?.items !== 'function') fail('MARKET_NATIVE_AGENT_INVENTORY_REQUIRED')
    return { slot, bot, sourceId: sourceId.toLowerCase() }
  }
  async function source(owner, args) {
    if (args.source === 'agent') {
      const actual = ownedAgent(owner, args.agentId)
      return { sourceId: actual.sourceId, sourceKind: 'agent_inventory' }
    }
    if (args.source !== 'player') fail('MARKET_SOURCE_PLAYER_OR_AGENT_REQUIRED')
    await session(owner)
    return { sourceId: owner.account.playerId, sourceKind: 'player_inventory' }
  }
  function scope(owner, action, terms, work) {
    return consent.run({ principalId: owner.ownerId, accountId: owner.account.playerId, action, ...terms }, work)
  }
  async function nativeAuthority(owner, listing, operationId) {
    const actualSource = await source(owner, { source: listing.sourceKind === 'agent_inventory' ? 'agent' : 'player' })
    if (actualSource.sourceId !== listing.sourceId || actualSource.sourceKind !== listing.sourceKind) fail('MARKET_LISTING_SOURCE_CHANGED')
    const live = listing.sourceKind === 'player_inventory' ? await session(owner) : null
    const payload = { authorityId: uuid(`market-authority:${listing.stockOperationId}:${operationId}`), operationId: listing.stockOperationId,
      listingId: listing.listingId, sellerId: owner.ownerId, sellerAccountId: owner.account.playerId, ownerPlayerId: owner.account.playerId,
      sourceId: listing.sourceId, sourceKind: listing.sourceKind, item: listing.item, count: listing.count, termsDigest: listing.termsDigest,
      expiresAtMs: Date.now() + 300000, consentId: operationId, confirmed: true, ...(live ? { connectionId: live.connectionId } : {}) }
    const legacy = (await pool.query('SELECT principal_id,payload FROM ac_discord_market_authorities WHERE stock_operation_id=$1', [listing.stockOperationId])).rows[0]
    if (legacy && legacy.principal_id !== owner.ownerId) fail('MARKET_AUTHORITY_OWNER_REQUIRED')
    let saved
    if (legacy?.payload?.consentId === operationId) {
      // An old delivery retry is not a fresh human consent after this upgrade.
      saved = legacy; payload.authorityId = legacy.payload.authorityId
    } else {
      await pool.query('INSERT INTO ac_discord_market_authority_revisions(authority_id,stock_operation_id,principal_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [payload.authorityId, listing.stockOperationId, owner.ownerId, payload])
      saved = (await pool.query('SELECT principal_id,payload FROM ac_discord_market_authority_revisions WHERE authority_id=$1', [payload.authorityId])).rows[0]
    }
    if (!saved || saved.principal_id !== owner.ownerId) fail('MARKET_AUTHORITY_OWNER_REQUIRED')
    const { expiresAtMs: ignoredExpiry, ...original } = saved.payload
    const { expiresAtMs, ...proposed } = payload
    void ignoredExpiry; void expiresAtMs
    if (stable(original) !== stable(proposed)) fail('MARKET_ORIGINAL_AUTHORITY_BINDING_CHANGED')
    await pluginApi('escrow/authorize', saved.payload)
    return saved.payload
  }
  async function browse() { return retirement ? { message: 'New sales use CITY on Unichain Sepolia. Open /assets to browse, register and trade items.', listings: [] } : { message: 'Minecraft item listings priced only in internal Game Coins.', listings: await market.list({ limit: 5 }) } }
  async function run(owner, originalOperationId, action, args = {}) {
    if (typeof originalOperationId !== 'string' || !originalOperationId || originalOperationId.length > 200) fail('MARKET_OPERATION_ID_REQUIRED')
    const operationId = uuid('game-market:' + originalOperationId)
    if (retirement && !['mailbox', 'claim'].includes(action)) await retirement.assertAllowed({ action: action === 'cancel' ? 'cancelListing' : action === 'confirm_buy' ? 'confirmDelivery' : action, listingId: args.listingId, purchaseId: args.purchaseId, principalId: owner.ownerId })
    if (action === 'list') {
      permitted(args, ['item', 'count', 'price', 'source', 'agentId'])
      const native = await source(owner, args)
      const listing = await market.prepareListing({ operationId, sellerId: owner.ownerId, sellerAccountId: owner.account.playerId,
        item: args.item, count: Number(args.count), price: String(args.price), ...native })
      return { message: `Review listing: ${listing.count} ${listing.item} for ${listing.price} Game Coins total. Confirm to escrow these real items.`, listing, confirmation: { action: 'confirm_listing', id: listing.listingId } }
    }
    if (action === 'confirm_listing') {
      permitted(args, ['listingId'])
      let listing = await market.getListing({ listingId: args.listingId, actorId: owner.ownerId })
      if (listing.sellerId !== owner.ownerId || listing.sellerAccountId !== owner.account.playerId) fail('MARKET_LISTING_OWNER_REQUIRED')
      listing = await scope(owner, 'list', { listingId: listing.listingId, terms: listing }, () => market.confirmListing({ listingId: listing.listingId, sellerId: owner.ownerId, termsDigest: listing.termsDigest }))
      if (!['awaiting_stock', 'stock_pending'].includes(listing.state)) return { message: `This listing is ${listing.state}; no extra items were removed.`, listing }
      const known = await pluginApi('escrow/status', { operationId: listing.stockOperationId })
      const reserve = { operationId: listing.stockOperationId, listingId: listing.listingId,
        sellerId: owner.ownerId, sellerAccountId: owner.account.playerId, sourceId: listing.sourceId, sourceKind: listing.sourceKind,
        item: listing.item, count: listing.count, termsDigest: listing.termsDigest }
      let receipt
      if (known.known === true) {
        if (known.receipt?.escrowed === true) receipt = known.receipt
        else if (known.pending === true) {
          // A pending intent is not a custody receipt. Reconcile its original
          // authority even after expiry/reconnect; never issue a replacement.
          if (!UUID.test(known.receipt?.authorityId || '') || Object.entries(reserve).some(([key, value]) => known.receipt[key] !== value)) fail('MARKET_ORIGINAL_NATIVE_INTENT_BINDING_REQUIRED')
          receipt = await pluginApi('escrow/reserve', { ...reserve, authorityId: known.receipt.authorityId })
        } else fail('MARKET_NATIVE_STOCK_RECEIPT_UNCERTAIN')
      } else if (known.known === false && known.pending !== true) {
        const authority = await nativeAuthority(owner, listing, operationId)
        receipt = await pluginApi('escrow/reserve', { ...reserve, authorityId: authority.authorityId })
      } else fail('MARKET_NATIVE_STOCK_STATUS_REQUIRED')
      listing = await market.confirmStock({ listingId: listing.listingId, sellerId: owner.ownerId, receipt })
      return { message: 'Listing opened with real escrowed items; no coins have been paid yet.', listing }
    }
    if (action === 'buy') {
      permitted(args, ['listingId'])
      const purchase = await market.quotePurchase({ operationId, buyerId: owner.ownerId, buyerAccountId: owner.account.playerId, listingId: args.listingId })
      return { message: `Review purchase: ${purchase.count} ${purchase.item} for ${purchase.price} Game Coins total. Confirm the exact quote to buy.`, purchase, confirmation: { action: 'confirm_buy', id: purchase.purchaseId } }
    }
    if (action === 'confirm_buy') {
      permitted(args, ['purchaseId', 'quoteDigest'])
      let purchase = await market.getPurchase({ purchaseId: args.purchaseId, buyerId: owner.ownerId })
      if (purchase.buyerId !== owner.ownerId || purchase.buyerAccountId !== owner.account.playerId || args.quoteDigest && args.quoteDigest !== purchase.quoteDigest) fail('MARKET_BUYER_QUOTE_REQUIRED')
      if (!retirement) purchase = await scope(owner, 'buy', { purchaseId: purchase.purchaseId, listingId: purchase.listingId, terms: purchase }, () => market.confirmPurchase({ purchaseId: purchase.purchaseId, buyerId: owner.ownerId, quoteDigest: purchase.quoteDigest }))
      if (purchase.state === 'settled') return { message: 'This purchase was already settled. Check your mailbox; no additional coins were spent.', purchase }
      const receipt = await pluginApi('escrow/assign', { operationId: purchase.deliveryOperationId, listingId: purchase.listingId,
        purchaseId: purchase.purchaseId, buyerId: owner.ownerId, termsDigest: purchase.termsDigest })
      purchase = await market.confirmDelivery({ purchaseId: purchase.purchaseId, buyerId: owner.ownerId, receipt })
      return { message: 'Purchase settled for Game Coins. Your backed items are in your marketplace mailbox; claim them while joined and approved.', purchase }
    }
    if (action === 'cancel') {
      permitted(args, ['listingId'])
      const current = await market.getListing({ listingId: args.listingId, actorId: owner.ownerId })
      if (current.sellerId !== owner.ownerId || current.sellerAccountId !== owner.account.playerId) fail('MARKET_LISTING_OWNER_REQUIRED')
      let listing = await scope(owner, 'cancel', { listingId: current.listingId, terms: current }, () => market.cancelListing({ operationId: uuid(`market-cancel:${current.listingId}:${owner.ownerId}`), listingId: current.listingId, sellerId: owner.ownerId }))
      if (listing.state === 'cancelled') return { message: 'Listing cancelled. Any returned items remain in your mailbox.', listing }
      const receipt = await pluginApi('escrow/return', { operationId: listing.returnOperationId, listingId: listing.listingId, sellerId: owner.ownerId, termsDigest: listing.termsDigest })
      listing = await market.confirmReturn({ listingId: listing.listingId, sellerId: owner.ownerId, receipt })
      return { message: 'Listing cancelled. Its escrowed items are safely returned to your marketplace mailbox.', listing }
    }
    if (action === 'mailbox') return { message: 'Your marketplace mailbox contains backed Minecraft items.', mailbox: await pluginApi('escrow/mailbox', { ownerId: owner.ownerId }) }
    if (action === 'claim') {
      permitted(args, ['mailboxId'])
      if (!args.mailboxId) {
        const mailbox = await pluginApi('escrow/mailbox', { ownerId: owner.ownerId })
        return { message: 'Choose a backed marketplace mailbox entry to claim while joined and approved.', mailboxes: (mailbox.entries || []).map(entry => ({ mailboxId: entry.mailboxId, item: entry.item, count: entry.count, status: entry.state })) }
      }
      if (!UUID.test(args.mailboxId || '')) fail('MARKET_MAILBOX_ID_REQUIRED')
      const current = await session(owner)
      const receipt = await pluginApi('escrow/claim', { operationId: uuid(`market-claim:${args.mailboxId}:${owner.account.playerId}`),
        mailboxId: args.mailboxId, ownerId: owner.ownerId, playerId: owner.account.playerId, connectionId: current.connectionId })
      if (!receipt.claimed || receipt.playerId !== owner.account.playerId || receipt.ownerId !== owner.ownerId || receipt.mailboxId !== args.mailboxId) fail('MARKET_CLAIM_RECEIPT_REQUIRED')
      return { message: 'Marketplace items claimed into your real Minecraft inventory.', receipt }
    }
    fail('MARKET_ACTION_UNSUPPORTED')
  }
  return { browse,
    async handleDiscord({ userId, operationId, action, args = {} }) {
      if (action === 'browse') return browse()
      return run(await ownerFor(userId), operationId, action, args)
    },
    async handleGame(event) {
      const words = Array.isArray(event.args) ? event.args : String(event.args || '').trim().split(/\s+/)
      let action = words[0] || 'browse'
      if (action === 'browse') return browse()
      const playerId = event.actorPlayerId || event.playerId
      if (!UUID.test(playerId || '') || !UUID.test(event.connectionId || '')) fail('MARKET_GAME_CONNECTION_REQUIRED')
      const linked = await identity.lookupMinecraft({ serverId: settings.serverId, playerId })
      const owner = await ownerFor(linked?.discordUserId)
      if (owner.account.playerId !== playerId.toLowerCase()) fail('MARKET_GAME_OWNER_REQUIRED')
      await session(owner, event.connectionId)
      if (action === 'confirm' || action === 'retry') {
        try { await market.getPurchase({ purchaseId: words[1], buyerId: owner.ownerId }); action = 'confirm_buy' }
        catch (error) {
          if (error.message !== 'GAME_MARKET_PURCHASE_OWNER_REQUIRED') throw error
          const saved = await market.getListing({ listingId: words[1], actorId: owner.ownerId })
          action = action === 'retry' && saved.state === 'return_pending' ? 'cancel' : 'confirm_listing'
        }
      }
      const args = action === 'list' ? { item: words[1], count: words[2], price: words[3], source: words[4] || 'player' }
        : ['buy', 'cancel', 'confirm_listing'].includes(action) ? { listingId: words[1] }
          : action === 'confirm_buy' ? { purchaseId: words[1], ...(words[2] ? { quoteDigest: words[2] } : {}) } : action === 'claim' ? { mailboxId: words[1] } : {}
      return run(owner, event.operationId, action, args)
    }
  }
}
