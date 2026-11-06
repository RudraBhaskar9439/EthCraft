import { randomUUID } from 'node:crypto'
import { parseUnits, formatUnits } from 'viem'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/i
const MATERIALS = new Set(['oak_planks', 'cobblestone', 'stone', 'dirt', 'sand', 'oak_log', 'stick', 'stone_bricks'])
const fail = code => { throw Object.assign(Error(code), { code }) }
const fields = (input, allowed) => {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key))) fail('INVENTORY_SHOP_FIELDS_REQUIRED')
}
const disclosure = 'Operator-supplied demo resources. Mumbai scenery is not shop stock. CITY payments use Unichain Sepolia test tokens.'

// Wallet linking precedes merchant escrow. Only the dedicated checkout service
// may prepare backed stock; this inventory service never signs or marks paid.
export async function createInventoryShop({ pool, identity, serverId, gameSession, readStock, prices, prepareCheckout, checkoutMode='browser' } = {}) {
  if (!pool?.query || !pool?.connect || typeof identity?.getMinecraftOwner !== 'function' || !serverId ||
      typeof gameSession !== 'function' || typeof readStock !== 'function' || !prices || typeof prices !== 'object' || Array.isArray(prices) ||
      prepareCheckout !== undefined && typeof prepareCheckout !== 'function' || !['browser','privy_game'].includes(checkoutMode)) fail('INVENTORY_SHOP_CONFIGURATION_REQUIRED')
  const priceList = Object.entries(prices).map(([item, value]) => {
    if (!MATERIALS.has(item) || typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) fail('INVENTORY_SHOP_UNIT_PRICE_REQUIRED')
    const amount = parseUnits(value, 18)
    if (amount <= 0n || amount * 64n > 100n * 10n ** 18n) fail('INVENTORY_SHOP_UNIT_PRICE_LIMIT')
    return { item, amount }
  })
  if (!priceList.length || priceList.length > 18) fail('INVENTORY_SHOP_CATALOG_REQUIRED')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_inventory_shop_quotes (
    quote_id uuid PRIMARY KEY, principal_id uuid NOT NULL, player_id uuid NOT NULL,
    connection_id uuid NOT NULL, item text NOT NULL, count integer NOT NULL CHECK(count BETWEEN 1 AND 64),
    unit_price text NOT NULL, total_price text NOT NULL, stock jsonb NOT NULL,
    expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'preview', checkout jsonb,
    created_at timestamptz NOT NULL DEFAULT now())`)

  async function account(input) {
    if (!UUID.test(input.playerId || '') || !UUID.test(input.connectionId || '')) fail('INVENTORY_SHOP_CURRENT_CONNECTION_REQUIRED')
    const playerId = input.playerId.toLowerCase(), owner = await identity.getMinecraftOwner(serverId, playerId)
    if (!UUID.test(owner?.ownerId || '') || owner.minecraftPlayerId?.toLowerCase() !== playerId) fail('INVENTORY_SHOP_OWNER_REQUIRED')
    const live = await gameSession({ serverId, playerId })
    if (live?.online !== true || live.pendingAuthentication !== false || live.playerId?.toLowerCase() !== playerId ||
        live.connectionId?.toLowerCase() !== input.connectionId.toLowerCase() || live.principalId?.toLowerCase() !== owner.ownerId.toLowerCase() ||
        live.playerName?.toLowerCase() !== owner.ownerName?.toLowerCase() ||
        !['discord_approved_local_profile', 'minecraft_online_mode'].includes(live.authenticationKind) || live.serverId && live.serverId !== serverId) fail('INVENTORY_SHOP_APPROVED_CONNECTION_REQUIRED')
    return { ...owner, playerId, connectionId: input.connectionId.toLowerCase() }
  }
  async function stock(owner) {
    const value = await readStock(owner)
    if (!value || !UUID.test(value.sourceId || '') || value.provenance !== 'operator_supplied_demo' || !HASH.test(value.fingerprint || '') ||
        !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs > Date.now() + 1000 || Date.now() - value.observedAtMs > 30000 ||
        !value.items || typeof value.items !== 'object' || Array.isArray(value.items) ||
        Object.entries(value.items).some(([item, count]) => !MATERIALS.has(item) || !Number.isSafeInteger(count) || count < 0 || count > 100000)) fail('INVENTORY_SHOP_VERIFIED_STOCK_REQUIRED')
    return value
  }
  const view = row => ({ quoteId: row.quote_id, item: row.item, count: row.count,
    unitPriceCity: formatUnits(BigInt(row.unit_price), 18), unitPriceBaseUnits: row.unit_price,
    totalCity: formatUnits(BigInt(row.total_price), 18), totalBaseUnits: row.total_price,
    expiresAtMs: +new Date(row.expires_at), status: row.status, currency: 'CITY', chainId: 1301,
    paymentReady: Boolean(prepareCheckout), checkoutMode, paid: false, disclosure,
    message: prepareCheckout ? checkoutMode==='privy_game'?'Review the exact lot and total. Confirm payment from your Privy game wallet in Minecraft.':'Review the exact lot and total. The next step opens your wallet; no payment has been submitted.'
      : 'Browsing is available. CITY payment is unavailable until a backed self-custody checkout is configured. No payment or item delivery occurred.' })
  async function catalog(input) {
    fields(input, ['playerId', 'connectionId'])
    const owner = await account(input), observed = await stock(owner)
    return { entries: priceList.map(({ item, amount }) => ({ item, available: observed.items[item] || 0,
      unitPriceCity: formatUnits(amount, 18), unitPriceBaseUnits: amount.toString() })),
    observedAtMs: observed.observedAtMs, currency: 'CITY', chainId: 1301, paymentReady: Boolean(prepareCheckout), disclosure }
  }
  async function quote(input) {
    fields(input, ['playerId', 'connectionId', 'item', 'count'])
    const owner = await account(input), selected = priceList.find(row => row.item === input.item)
    if (!selected || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > 64) fail('INVENTORY_SHOP_ITEM_QUANTITY_REQUIRED')
    const observed = await stock(owner)
    if ((observed.items[input.item] || 0) < input.count) fail('INVENTORY_SHOP_INSUFFICIENT_STOCK')
    const result = await pool.query(`INSERT INTO ac_inventory_shop_quotes
      (quote_id,principal_id,player_id,connection_id,item,count,unit_price,total_price,stock,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes') RETURNING *`,
    [randomUUID(), owner.ownerId, owner.playerId, owner.connectionId, selected.item, input.count, selected.amount.toString(),
      (selected.amount * BigInt(input.count)).toString(), observed])
    return view(result.rows[0])
  }
  async function checkout(input) {
    fields(input, ['playerId', 'connectionId', 'quoteId'])
    const owner = await account(input)
    if (!UUID.test(input.quoteId || '')) fail('INVENTORY_SHOP_QUOTE_REQUIRED')
    const row = (await pool.query('SELECT * FROM ac_inventory_shop_quotes WHERE quote_id=$1 AND principal_id=$2 AND player_id=$3',
      [input.quoteId, owner.ownerId, owner.playerId])).rows[0]
    if (!row) fail('INVENTORY_SHOP_QUOTE_OWNER_REQUIRED')
    if (!prepareCheckout) fail('INVENTORY_SHOP_SELF_CUSTODY_CHECKOUT_NOT_CONFIGURED')
    if (row.checkout) {
      if(row.checkout.mode==='privy_game'){
        if(checkoutMode!=='privy_game')fail('INVENTORY_SHOP_PRIVY_GAME_NOT_ENABLED')
        return{...view(row),...await prepareCheckout({quoteId:row.quote_id,principalId:owner.ownerId,playerId:owner.playerId,item:row.item,count:row.count,totalBaseUnits:row.total_price,stock:row.stock,expiresAtMs:+new Date(row.expires_at)})}
      }
      return { ...view(row), ...row.checkout }
    }
    if (+new Date(row.expires_at) <= Date.now() || row.connection_id !== owner.connectionId) fail('INVENTORY_SHOP_FRESH_QUOTE_REQUIRED')
    const observed = await stock(owner)
    if (observed.sourceId !== row.stock.sourceId || (observed.items[row.item] || 0) < row.count) fail('INVENTORY_SHOP_INSUFFICIENT_STOCK')
    await pool.query("UPDATE ac_inventory_shop_quotes SET status='checkout_pending' WHERE quote_id=$1 AND checkout IS NULL", [row.quote_id])
    const result = await prepareCheckout({ quoteId: row.quote_id, principalId: owner.ownerId, playerId: owner.playerId,
      item: row.item, count: row.count, totalBaseUnits: row.total_price, stock: row.stock, expiresAtMs:+new Date(row.expires_at) })
    if(checkoutMode==='privy_game'){
      if(result?.mode!=='privy_game'||!UUID.test(result.orderId||'')||!/^[A-Za-z0-9_-]{43}$/.test(result.consentNonce||'')||
        result.quoteId!==row.quote_id||result.principalId!==owner.ownerId||result.item!==row.item||result.count!==row.count||
        result.totalBaseUnits!==row.total_price||result.chainId!==1301||result.paid!==false)fail('INVENTORY_SHOP_CHECKOUT_RECEIPT_REQUIRED')
      await pool.query('UPDATE ac_inventory_shop_quotes SET status=$3,checkout=$2 WHERE quote_id=$1',[row.quote_id,{mode:'privy_game',orderId:result.orderId},'privy_game'])
      return{...view(row),...result}
    }
    let url
    try { url = new URL(result?.checkoutUrl) } catch { fail('INVENTORY_SHOP_CHECKOUT_RECEIPT_REQUIRED') }
    const linked = result.status === 'wallet_link_required' && result.nativeCustodyConfirmed === false
    const escrowed = result.status === 'awaiting_wallet' && result.nativeCustodyConfirmed === true && UUID.test(result.nativeReceiptId || '')
    if ((!linked && !escrowed) || result.quoteId !== row.quote_id || result.principalId !== owner.ownerId ||
        result.item !== row.item || result.count !== row.count || result.totalBaseUnits !== row.total_price ||
        url.origin !== 'http://127.0.0.1:8789' || url.pathname !== '/inventory-shop/checkout' || !url.hash || url.username || url.password) fail('INVENTORY_SHOP_CHECKOUT_RECEIPT_REQUIRED')
    const retained = { status: result.status, checkoutUrl: url.href, paid: false,
      message: 'Open the local wallet checkout to review and sign. This inventory screen has not submitted payment.' }
    const saved = (await pool.query('UPDATE ac_inventory_shop_quotes SET status=$3,checkout=$2 WHERE quote_id=$1 RETURNING *', [row.quote_id, retained, retained.status])).rows[0]
    return { ...view(saved), ...retained }
  }
  return { catalog, quote, checkout }
}
