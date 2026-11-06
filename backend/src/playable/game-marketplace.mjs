import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HEX=/^[a-f0-9]{64}$/
const MAX=9223372036854775807n
const fail=code=>{throw Object.assign(Error(code),{code})}
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value
const hash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
const derived=(id,kind)=>{const h=hash([id,kind]).slice(0,32);return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-')}
const uuid=value=>{if(!UUID.test(value||''))fail('GAME_MARKET_UUID_REQUIRED');return value.toLowerCase()}
function normalize(input){
 const item=String(input.item||'').startsWith('minecraft:')?input.item:'minecraft:'+input.item
 if(input.currency!==undefined&&input.currency!=='GAME_COINS')fail('GAME_MARKET_GAME_COINS_ONLY')
 if(!/^minecraft:[a-z0-9_]{1,64}$/.test(item)||!Number.isSafeInteger(input.count)||input.count<1||input.count>64||typeof input.price!=='string'||!/^[1-9][0-9]{0,18}$/.test(input.price)||BigInt(input.price)>MAX||!['player_inventory','agent_inventory'].includes(input.sourceKind))fail('GAME_MARKET_BOUNDED_FULL_LOT_TERMS_REQUIRED')
 const value={listingId:uuid(input.operationId),sellerId:uuid(input.sellerId),sellerAccountId:uuid(input.sellerAccountId),item,count:input.count,price:String(BigInt(input.price)),sourceId:uuid(input.sourceId),sourceKind:input.sourceKind,currency:'GAME_COINS'}
 if(value.sourceKind==='player_inventory'&&value.sourceId!==value.sellerAccountId)fail('GAME_MARKET_PLAYER_SOURCE_ACCOUNT_REQUIRED')
 return value
}
export const listingTermsDigest=input=>hash(normalize(input))
const listingView=row=>({listingId:row.listing_id,sellerId:row.seller_id,sellerAccountId:row.seller_account_id,item:row.item,count:row.count,price:String(row.price),currency:'GAME_COINS',priceKind:'TOTAL_FULL_LOT',sourceId:row.source_id,sourceKind:row.source_kind,termsDigest:row.terms_digest,stockOperationId:row.stock_operation_id,state:row.state,custodyId:row.custody_id,fingerprint:row.fingerprint,returnOperationId:row.return_operation_id,reservedPurchaseId:row.reserved_purchase_id,authorization:row.authority_receipt})
const purchaseView=row=>({purchaseId:row.purchase_id,listingId:row.listing_id,sellerId:row.seller_id,sellerAccountId:row.seller_account_id,buyerId:row.buyer_id,buyerAccountId:row.buyer_account_id,item:row.item,count:row.count,price:String(row.price),currency:'GAME_COINS',priceKind:'TOTAL_FULL_LOT',termsDigest:row.terms_digest,quoteDigest:row.quote_digest,deliveryOperationId:row.delivery_operation_id,custodyId:row.custody_id,fingerprint:row.fingerprint,expiresAt:new Date(row.expires_at).toISOString(),state:row.state})

export async function createGameMarketplace({pool,authorize,resolveAccount,allowLegacyGameCoinsFixture=false}={}){
 if(!pool?.connect||typeof authorize!=='function'||typeof resolveAccount!=='function')fail('GAME_MARKET_AUTHORITY_AND_ACCOUNT_RESOLVER_REQUIRED')
 if(allowLegacyGameCoinsFixture===true) await pool.query(await readFile(new URL('game-marketplace.sql',import.meta.url),'utf8'))
 const transaction=async work=>{const tx=await pool.connect();try{await tx.query('BEGIN');const value=await work(tx);await tx.query('COMMIT');return value}catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}}
 async function account(principalId,accountId){
  principalId=uuid(principalId);accountId=uuid(accountId)
  const resolved=await resolveAccount({principalId})
  if(typeof resolved!=='string'||resolved.toLowerCase()!==accountId)fail('GAME_MARKET_EXISTING_ACCOUNT_OWNER_REQUIRED')
  if(!(await pool.query('SELECT 1 FROM ac_game_players WHERE player_id=$1',[accountId])).rowCount)fail('GAME_MARKET_EXISTING_ACCOUNT_REQUIRED')
 }
 async function consent(value){const result=await authorize(value);if(result!==true&&result?.authorized!==true)fail('GAME_MARKET_EXPLICIT_OWNER_CONSENT_REQUIRED');return result===true?{authorized:true}:JSON.parse(JSON.stringify(result))}
 async function listing(tx,id,sellerId){const row=(await tx.query('SELECT * FROM ac_game_market_listings WHERE listing_id=$1 FOR UPDATE',[uuid(id)])).rows[0];if(!row||sellerId!==undefined&&row.seller_id!==uuid(sellerId))fail('GAME_MARKET_LISTING_OWNER_REQUIRED');return row}
 async function purchase(tx,id,buyerId){const row=(await tx.query('SELECT * FROM ac_game_market_purchases WHERE purchase_id=$1 FOR UPDATE',[uuid(id)])).rows[0];if(!row||row.buyer_id!==uuid(buyerId))fail('GAME_MARKET_PURCHASE_OWNER_REQUIRED');return row}
 async function prepareListing(input){
  if(allowLegacyGameCoinsFixture!==true)fail('GAME_COINS_RETIRED')
  const terms=normalize(input),digest=hash(terms)
  if(input.termsDigest!==undefined&&input.termsDigest!==digest)fail('GAME_MARKET_LISTING_DIGEST_MISMATCH')
  await account(terms.sellerId,terms.sellerAccountId)
  return transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['game-market-listing:'+terms.listingId])
   let row=(await tx.query('SELECT * FROM ac_game_market_listings WHERE listing_id=$1',[terms.listingId])).rows[0]
   if(row){if(row.terms_digest!==digest)fail('GAME_MARKET_LISTING_IMMUTABLE_TERMS');return listingView(row)}
   row=(await tx.query(`INSERT INTO ac_game_market_listings(listing_id,seller_id,seller_account_id,item,count,price,source_id,source_kind,terms_digest,stock_operation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[terms.listingId,terms.sellerId,terms.sellerAccountId,terms.item,terms.count,terms.price,terms.sourceId,terms.sourceKind,digest,derived(terms.listingId,'stock')])).rows[0]
   return listingView(row)
  })
 }
 async function confirmListing({listingId,sellerId,termsDigest}){
  if(allowLegacyGameCoinsFixture!==true)fail('GAME_COINS_RETIRED')
  return transaction(async tx=>{
   const row=await listing(tx,listingId,sellerId)
   if(termsDigest!==undefined&&termsDigest!==row.terms_digest)fail('GAME_MARKET_LISTING_DIGEST_MISMATCH')
   if(row.state!=='awaiting_stock'){if(['stock_pending','open','reserved','sold','return_pending','cancelled'].includes(row.state))return listingView(row);fail('GAME_MARKET_LISTING_NOT_CONFIRMABLE')}
   await account(row.seller_id,row.seller_account_id)
   const authority=await consent({action:'list',principalId:row.seller_id,accountId:row.seller_account_id,operationId:row.listing_id,...listingView(row)})
   return listingView((await tx.query("UPDATE ac_game_market_listings SET state='stock_pending',authority_receipt=$2,updated_at=now() WHERE listing_id=$1 RETURNING *",[row.listing_id,authority])).rows[0])
  })
 }
 function bind(receipt,expected){if(!receipt||typeof receipt!=='object'||Object.entries(expected).some(([key,value])=>receipt[key]!==value))fail('GAME_MARKET_NATIVE_RECEIPT_BINDING_REQUIRED')}
 async function confirmStock({listingId,sellerId,receipt}){
  if(allowLegacyGameCoinsFixture!==true)fail('GAME_COINS_RETIRED')
  return transaction(async tx=>{
   const row=await listing(tx,listingId,sellerId)
   bind(receipt,{operationId:row.stock_operation_id,listingId:row.listing_id,sellerId:row.seller_id,sellerAccountId:row.seller_account_id,sourceId:row.source_id,sourceKind:row.source_kind,item:row.item,count:row.count,termsDigest:row.terms_digest})
   if(row.stock_receipt){if(!isDeepStrictEqual(row.stock_receipt,receipt))fail('GAME_MARKET_NATIVE_RECEIPT_IMMUTABLE');return listingView(row)}
   if(row.state!=='stock_pending')fail('GAME_MARKET_STOCK_INTENT_REQUIRED')
   if(receipt.escrowed!==true){if(receipt.escrowed!==false)fail('GAME_MARKET_ESCROW_RECEIPT_REQUIRED');return listingView((await tx.query("UPDATE ac_game_market_listings SET state='stock_failed',stock_receipt=$2,updated_at=now() WHERE listing_id=$1 RETURNING *",[row.listing_id,receipt])).rows[0])}
   if(receipt.custodyId!==row.listing_id||!HEX.test(receipt.fingerprint||''))fail('GAME_MARKET_EXACT_NATIVE_CUSTODY_REQUIRED')
   return listingView((await tx.query("UPDATE ac_game_market_listings SET state='open',stock_receipt=$2,custody_id=$3,fingerprint=$4,updated_at=now() WHERE listing_id=$1 RETURNING *",[row.listing_id,receipt,receipt.custodyId,receipt.fingerprint])).rows[0])
  })
 }
 async function quotePurchase({operationId,buyerId,buyerAccountId,listingId}){
  if(allowLegacyGameCoinsFixture!==true)fail('GAME_COINS_RETIRED')
  operationId=uuid(operationId);buyerId=uuid(buyerId);buyerAccountId=uuid(buyerAccountId)
  await account(buyerId,buyerAccountId)
  return transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['game-market-purchase:'+operationId])
   const old=(await tx.query('SELECT * FROM ac_game_market_purchases WHERE purchase_id=$1',[operationId])).rows[0]
   if(old){if(old.buyer_id!==buyerId||old.buyer_account_id!==buyerAccountId||old.listing_id!==uuid(listingId))fail('GAME_MARKET_PURCHASE_IMMUTABLE_TERMS');return purchaseView(old)}
   const row=await listing(tx,listingId)
   if(row.state!=='open')fail('GAME_MARKET_LOT_NOT_AVAILABLE')
   if(row.seller_id===buyerId||row.seller_account_id===buyerAccountId)fail('GAME_MARKET_CANNOT_BUY_OWN_LISTING')
   const expiry=(await tx.query("SELECT clock_timestamp()+interval '5 minutes' AS value")).rows[0].value
   const terms={listingId:row.listing_id,sellerId:row.seller_id,sellerAccountId:row.seller_account_id,buyerId,buyerAccountId,item:row.item,count:row.count,price:String(row.price),termsDigest:row.terms_digest,custodyId:row.custody_id,fingerprint:row.fingerprint,expiresAt:expiry.toISOString(),currency:'GAME_COINS'}
   return purchaseView((await tx.query(`INSERT INTO ac_game_market_purchases(purchase_id,listing_id,seller_id,seller_account_id,buyer_id,buyer_account_id,item,count,price,terms_digest,quote_digest,delivery_operation_id,custody_id,fingerprint,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[operationId,row.listing_id,row.seller_id,row.seller_account_id,buyerId,buyerAccountId,row.item,row.count,row.price,row.terms_digest,hash(terms),derived(operationId,'delivery'),row.custody_id,row.fingerprint,expiry])).rows[0])
  })
 }
 async function confirmPurchase({purchaseId,buyerId,quoteDigest}){
  if(allowLegacyGameCoinsFixture!==true)fail('GAME_COINS_RETIRED')
  return transaction(async tx=>{
   const order=await purchase(tx,purchaseId,buyerId)
   if(order.quote_digest!==quoteDigest)fail('GAME_MARKET_QUOTE_DIGEST_MISMATCH')
   if(['reserved','settled'].includes(order.state))return purchaseView(order)
   if(order.state!=='quoted'||!(await tx.query('SELECT expires_at>clock_timestamp() AS valid FROM ac_game_market_purchases WHERE purchase_id=$1',[order.purchase_id])).rows[0].valid)fail('GAME_MARKET_QUOTE_EXPIRED')
   const stock=await listing(tx,order.listing_id)
   if(stock.state!=='open'||stock.terms_digest!==order.terms_digest||stock.fingerprint!==order.fingerprint)fail('GAME_MARKET_LOT_NOT_AVAILABLE')
   await account(order.buyer_id,order.buyer_account_id)
   await consent({action:'buy',principalId:order.buyer_id,accountId:order.buyer_account_id,operationId:order.purchase_id,...purchaseView(order)})
   const balances=(await tx.query('SELECT * FROM ac_game_players WHERE player_id=ANY($1::uuid[]) ORDER BY player_id FOR UPDATE',[[order.buyer_account_id,order.seller_account_id]])).rows
   const buyer=balances.find(value=>value.player_id===order.buyer_account_id)
   if(!buyer||BigInt(buyer.available)<BigInt(order.price)||BigInt(buyer.held)+BigInt(order.price)>MAX)fail('GAME_MARKET_INSUFFICIENT_GAME_COINS')
   await tx.query('UPDATE ac_game_players SET available=available-$2::bigint,held=held+$2::bigint WHERE player_id=$1',[order.buyer_account_id,order.price])
   await tx.query("INSERT INTO ac_game_market_ledger VALUES($1,$2,$3,'reserve',-$4::bigint,$4::bigint,now())",['reserve:'+order.purchase_id,order.buyer_account_id,order.purchase_id,order.price])
   await tx.query("UPDATE ac_game_market_listings SET state='reserved',reserved_purchase_id=$2,updated_at=now() WHERE listing_id=$1",[stock.listing_id,order.purchase_id])
   return purchaseView((await tx.query("UPDATE ac_game_market_purchases SET state='reserved',updated_at=now() WHERE purchase_id=$1 RETURNING *",[order.purchase_id])).rows[0])
  })
 }
 async function confirmDelivery({purchaseId,buyerId,receipt}){
  return transaction(async tx=>{
   const order=await purchase(tx,purchaseId,buyerId),stock=await listing(tx,order.listing_id)
   bind(receipt,{operationId:order.delivery_operation_id,listingId:order.listing_id,purchaseId:order.purchase_id,buyerId:order.buyer_id,ownerId:order.buyer_id,item:order.item,count:order.count,custodyId:order.custody_id,fingerprint:order.fingerprint,termsDigest:order.terms_digest,assigned:true})
   if(order.delivery_receipt){if(!isDeepStrictEqual(order.delivery_receipt,receipt))fail('GAME_MARKET_NATIVE_RECEIPT_IMMUTABLE');return purchaseView(order)}
   if(order.state!=='reserved'||stock.state!=='reserved'||stock.reserved_purchase_id!==order.purchase_id)fail('GAME_MARKET_FUNDED_DELIVERY_INTENT_REQUIRED')
   const balances=(await tx.query('SELECT * FROM ac_game_players WHERE player_id=ANY($1::uuid[]) ORDER BY player_id FOR UPDATE',[[order.buyer_account_id,order.seller_account_id]])).rows
   const buyer=balances.find(value=>value.player_id===order.buyer_account_id),seller=balances.find(value=>value.player_id===order.seller_account_id)
   if(!buyer||!seller||BigInt(buyer.held)<BigInt(order.price)||BigInt(seller.available)+BigInt(order.price)>MAX)fail('GAME_MARKET_RESERVED_FUNDS_RECONCILIATION_REQUIRED')
   await tx.query('UPDATE ac_game_players SET held=held-$2::bigint WHERE player_id=$1',[order.buyer_account_id,order.price])
   await tx.query('UPDATE ac_game_players SET available=available+$2::bigint WHERE player_id=$1',[order.seller_account_id,order.price])
   await tx.query("INSERT INTO ac_game_market_ledger VALUES($1,$2,$3,'settle',0,-$5::bigint,now()),($1,$4,$3,'settle',$5::bigint,0,now())",['settle:'+order.purchase_id,order.buyer_account_id,order.purchase_id,order.seller_account_id,order.price])
   await tx.query("UPDATE ac_game_market_listings SET state='sold',updated_at=now() WHERE listing_id=$1",[stock.listing_id])
   return purchaseView((await tx.query("UPDATE ac_game_market_purchases SET state='settled',delivery_receipt=$2,updated_at=now() WHERE purchase_id=$1 RETURNING *",[order.purchase_id,receipt])).rows[0])
  })
 }
 async function cancelListing({operationId,listingId,sellerId}){
  operationId=uuid(operationId)
  return transaction(async tx=>{
   const row=await listing(tx,listingId,sellerId)
   if(row.cancel_operation_id){if(row.cancel_operation_id!==operationId)fail('GAME_MARKET_CANCELLATION_IMMUTABLE_TERMS');return listingView(row)}
   if(row.state!=='open')fail('GAME_MARKET_ONLY_OPEN_LOT_CAN_CANCEL')
   await consent({action:'cancel',principalId:row.seller_id,accountId:row.seller_account_id,operationId,...listingView(row)})
   return listingView((await tx.query("UPDATE ac_game_market_listings SET state='return_pending',cancel_operation_id=$2,return_operation_id=$3,updated_at=now() WHERE listing_id=$1 RETURNING *",[row.listing_id,operationId,derived(operationId,'return')])).rows[0])
  })
 }
 async function confirmReturn({listingId,sellerId,receipt}){
  return transaction(async tx=>{
   const row=await listing(tx,listingId,sellerId)
   bind(receipt,{operationId:row.return_operation_id,listingId:row.listing_id,sellerId:row.seller_id,ownerId:row.seller_id,item:row.item,count:row.count,custodyId:row.custody_id,fingerprint:row.fingerprint,termsDigest:row.terms_digest,returned:true,assigned:true})
   if(row.return_receipt){if(!isDeepStrictEqual(row.return_receipt,receipt))fail('GAME_MARKET_NATIVE_RECEIPT_IMMUTABLE');return listingView(row)}
   if(row.state!=='return_pending')fail('GAME_MARKET_RETURN_INTENT_REQUIRED')
   return listingView((await tx.query("UPDATE ac_game_market_listings SET state='cancelled',return_receipt=$2,updated_at=now() WHERE listing_id=$1 RETURNING *",[row.listing_id,receipt])).rows[0])
  })
 }
 return{prepareListing,confirmListing,confirmStock,quotePurchase,confirmPurchase,confirmDelivery,cancelListing,confirmReturn,
  getListing:({listingId,actorId})=>transaction(async tx=>listingView(await listing(tx,listingId,actorId))),
  getPurchase:({purchaseId,buyerId})=>transaction(async tx=>purchaseView(await purchase(tx,purchaseId,buyerId))),
  list:async({limit=25}={})=>{if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail('GAME_MARKET_LIST_LIMIT_REQUIRED');return(await pool.query("SELECT listing_id,item,count,price,state,created_at FROM ac_game_market_listings WHERE state='open' ORDER BY created_at DESC LIMIT $1",[limit])).rows.map(row=>({listingId:row.listing_id,item:row.item,count:row.count,price:String(row.price),currency:'GAME_COINS',priceKind:'TOTAL_FULL_LOT',state:row.state}))},
  close:async()=>{}}
}
