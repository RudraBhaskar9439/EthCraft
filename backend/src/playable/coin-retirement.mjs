// Read-only retirement boundary. This never converts, grants, moves or deletes coins/items.
const reads = new Set(['balance','history','status','list','getListing','getPurchase','mailbox'])
const withdrawals = new Set(['cancelListing','confirmReturn','reconcileStock'])
const fail = code => { throw new Error(code) }
export function createCoinRetirement({pool}) {
  if (!pool?.query) fail('RETIREMENT_DATABASE_REQUIRED')
  async function listingDisposition({listingId,principalId}) {
    const listing=(await pool.query('SELECT * FROM ac_game_market_listings WHERE listing_id=$1',[listingId])).rows[0]
    if (!listing || listing.seller_id!==principalId) fail('RETIREMENT_LISTING_OWNER_REQUIRED')
    const disposition={open:'OWNER_WITHDRAW_ONLY',return_pending:'RECONCILE_ORIGINAL_RETURN',stock_pending:'RECONCILE_ORIGINAL_STOCK_NO_ACTIVATION',awaiting_stock:'UNBACKED_DRAFT_NO_RESERVE',reserved:'FINISH_ORIGINAL_FUNDED_PURCHASE',sold:'BUYER_MAILBOX_CLAIM_ONLY',cancelled:'SELLER_MAILBOX_CLAIM_ONLY',stock_failed:'NO_STOCK_BACKING'}[listing.state] ?? 'MANUAL_REVIEW'
    return {listingId:listing.listing_id,state:listing.state,disposition,stockOperationId:listing.stock_operation_id,returnOperationId:listing.return_operation_id,custodyId:listing.custody_id,termsDigest:listing.terms_digest}
  }
  async function assertAllowed({action,listingId,purchaseId,principalId,nativeOwnerId}) {
    if (reads.has(action)) return {allowed:true,readOnly:true}
    if (action==='claim') {
      if (!principalId || nativeOwnerId!==principalId) fail('RETIREMENT_NATIVE_MAILBOX_OWNER_REQUIRED')
      return {allowed:true,recoveryOnly:true,nativeOwnershipMustBeVerified:true}
    }
    if (withdrawals.has(action)) {
      const result=await listingDisposition({listingId,principalId})
      const states={cancelListing:['open','return_pending','cancelled'],confirmReturn:['return_pending','cancelled'],claim:['open','return_pending','cancelled','sold'],reconcileStock:['stock_pending','stock_failed','open']}[action]
      if (!states.includes(result.state)) fail('RETIREMENT_RECOVERY_STATE_REQUIRED')
      // This is only a scope check: caller MUST retain original owner consent and native receipt checks.
      return {allowed:true,recoveryOnly:true,...result}
    }
    if (action==='confirmDelivery') {
      const row=(await pool.query(`SELECT p.*,l.state AS listing_state,l.reserved_purchase_id,a.held,
        EXISTS(SELECT 1 FROM ac_game_market_ledger x WHERE x.purchase_id=p.purchase_id AND x.account_id=p.buyer_account_id
        AND x.operation_key='reserve:'||p.purchase_id::text AND x.kind='reserve' AND x.delta_available=-p.price AND x.delta_held=p.price) AS funded
        FROM ac_game_market_purchases p JOIN ac_game_market_listings l USING(listing_id)
        JOIN ac_game_players a ON a.player_id=p.buyer_account_id WHERE p.purchase_id=$1`,[purchaseId])).rows[0]
      if (!row || row.buyer_id!==principalId) fail('RETIREMENT_PURCHASE_OWNER_REQUIRED')
      if (row.state==='settled') return {allowed:true,replayOnly:true,purchaseId}
      if (row.state!=='reserved' || row.listing_state!=='reserved' || row.reserved_purchase_id!==purchaseId || !row.funded || BigInt(row.held)<BigInt(row.price)) fail('RETIREMENT_ORIGINAL_FUNDED_PURCHASE_REQUIRED')
      return {allowed:true,recoveryOnly:true,purchaseId,listingId:row.listing_id,deliveryOperationId:row.delivery_operation_id,termsDigest:row.terms_digest}
    }
    fail('GAME_COINS_RETIRED')
  }
  async function snapshot() {
    const [accounts,listings,purchases,sales]=await Promise.all([
      pool.query('SELECT count(*)::int AS accounts,coalesce(sum(available),0)::text AS available,coalesce(sum(held),0)::text AS held FROM ac_game_players'),
      pool.query('SELECT state,count(*)::int AS count FROM ac_game_market_listings GROUP BY state ORDER BY state'),
      pool.query('SELECT state,count(*)::int AS count FROM ac_game_market_purchases GROUP BY state ORDER BY state'),
      pool.query("SELECT count(*)::int AS pending FROM ac_game_sales WHERE state='prepared'")])
    return {mode:'ONCHAIN_ONLY_NO_CONVERSION',accounts:accounts.rows[0],listings:listings.rows,purchases:purchases.rows,preparedShopSales:sales.rows[0].pending}
  }
  async function assertCutoverReady({nativeSnapshot}={}) {
    const state=await snapshot()
    if (state.accounts.held!=='0' || state.purchases.some(x=>x.state==='reserved' && x.count>0) || state.preparedShopSales>0) fail('RETIREMENT_FUNDED_RECOVERY_PENDING')
    // Native journal proof is mandatory; a missing/unknown response is never zero.
    if (nativeSnapshot?.verified!==true || !Number.isSafeInteger(nativeSnapshot.unresolvedIntents) || nativeSnapshot.unresolvedIntents!==0) fail('RETIREMENT_NATIVE_RECONCILIATION_REQUIRED')
    return {...state,cutoverReady:true}
  }
  return {policy:()=>({mode:'ONCHAIN_ONLY_NO_CONVERSION',newCoinActions:false,preserveHistory:true,ownerWithdrawals:true}),assertAllowed,listingDisposition,snapshot,assertCutoverReady}
}
