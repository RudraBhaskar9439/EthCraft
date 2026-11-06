// Isolated database, local signatures and injected native/JWT fixtures only.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import pg from '../../backend/node_modules/pg/lib/index.js'
import {createInventoryShop} from '../../backend/src/playable/inventory-shop.mjs'
import {createInventoryShopCheckout,inventoryShopNativeLotMatches,inventoryShopCancellationOperation,inventoryShopRecoveryPreview} from '../../backend/src/playable/inventory-shop-checkout.mjs'
const {generatePrivateKey,privateKeyToAccount}=createRequire(new URL('../../backend/package.json',import.meta.url))('viem/accounts')

const env=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='test_inventory_checkout_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:env.databaseUrl,max:1})
const pool=new pg.Pool({connectionString:env.databaseUrl,max:4,options:'-c search_path='+schema})
const ownerId=randomUUID(),playerId=randomUUID(),connectionId=randomUUID(),sourceId=randomUUID(),account=privateKeyToAccount(generatePrivateKey())
const owner={ownerId,ownerName:'micro',minecraftPlayerId:playerId,privySubject:'did:privy:fixture-owner'}
const session={online:true,playerId,connectionId,principalId:ownerId,playerName:'Micro',pendingAuthentication:false,authenticationKind:'discord_approved_local_profile'}
const identity={getMinecraftOwner:async()=>owner},gameSession=async()=>session
const stock={sourceId,items:{oak_planks:32},selections:{oak_planks:0},observedAtMs:Date.now(),fingerprint:'a'.repeat(64),provenance:'operator_supplied_demo'}
let opened=0,created=false
try{
  await admin.query('CREATE SCHEMA '+schema);created=true
  const checkout=await createInventoryShopCheckout({pool,identity,serverId:'fixture',gameSession,
    verifyPrivyToken:async token=>({subject:token==='fixture-owner-token'?owner.privySubject:'did:privy:other'}),native:async()=>{throw Error('No native effects in fixture')},
    getOperatorRuntime:async()=>{opened++;throw Error('FIXTURE_OPERATOR_RUNTIME_UNAVAILABLE')},
    merchant:{principalId:randomUUID(),minecraftPlayerId:sourceId,sourceId,sourceKind:'player_inventory',walletAddress:account.address,operatorSuppliedDemo:true},expectedWallet:account.address})
  const shop=await createInventoryShop({pool,identity,serverId:'fixture',gameSession,readStock:async()=>({...stock,observedAtMs:Date.now()}),prices:{oak_planks:'0.125'},prepareCheckout:checkout.prepareCheckout})
  const input={playerId,connectionId},quote=await shop.quote({...input,item:'oak_planks',count:8}),browser=await shop.checkout({...input,quoteId:quote.quoteId})
  assert.equal(browser.status,'wallet_link_required');assert.equal(browser.paid,false);assert.equal(opened,0)
  const request=new URLSearchParams(new URL(browser.checkoutUrl).hash.slice(1)).get('request'),auth={request,accessToken:'fixture-owner-token'}
  assert.equal((await checkout.state(auth)).walletLinked,false)
  await assert.rejects(checkout.state({...auth,accessToken:'other-token'}),/CHECKOUT_OWNER_REQUIRED/)
  console.log('PASS native quote opens owner-bound self-custody login without merchant effects or a paid/custody claim')

  const challenge=await checkout.challenge({...auth,address:account.address})
  assert.match(challenge.message,/This message authorizes no transaction or token spend/)
  const signature=await account.signMessage({message:challenge.message})
  assert.equal((await checkout.link({...auth,address:account.address,signature})).spendingAuthorized,false)
  await assert.rejects(checkout.link({...auth,address:account.address,signature}),/EXPIRED_OR_USED/)
  const verified=await checkout.state(auth)
  assert.equal(verified.walletLinked,true);assert.equal(verified.paid,false);assert.equal(verified.nativeCustodyConfirmed,false)
  session.pendingAuthentication=true
  await assert.rejects(checkout.state(auth),/APPROVED_CONNECTION_REQUIRED/)
  session.pendingAuthentication=false
  await assert.rejects(checkout.prepare(auth),/FIXTURE_OPERATOR_RUNTIME_UNAVAILABLE/)
  assert.equal(opened,1)
  console.log('PASS actual local wallet signature links only the authenticated fixture principal once; stale game access and absent merchant runtime stay refused')

  const operationId=randomUUID()
  await pool.query('INSERT INTO ac_inventory_shop_unsigned(operation_id,quote_id,principal_id,request) VALUES($1,$2,$3,$4)',[operationId,quote.quoteId,ownerId,{from:account.address,to:account.address,data:'0x',value:'0x0',chainId:'0x515'}])
  await checkout.unknown({...auth,operationId})
  const uncertain=await checkout.state(auth)
  assert.equal(uncertain.transaction.unknown_outcome,true);assert.equal(uncertain.paid,false)
  await assert.rejects(checkout.unknown({...auth,operationId}),/BROWSER_INTENT_REQUIRED/)
  await assert.rejects(checkout.cancel(auth),/UNRESOLVED_BUYER_TRANSACTION/)
  await assert.rejects(checkout.unknown({...auth,operationId:randomUUID()}),/BROWSER_INTENT_REQUIRED/)
  assert.equal(uncertain.delivered,false)
  await checkout.rejected({...auth,operationId})
  const cancelled=await checkout.cancel(auth)
  assert.equal(cancelled.cancelled,true);assert.equal(cancelled.paid,false)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ac_inventory_shop_unsigned WHERE operation_id=$1',[operationId])).rows[0].count,1)
  await assert.rejects(checkout.buy(auth),/CANCELLING_OR_CANCELLED/)
  const next=await shop.quote({...input,item:'oak_planks',count:2}),nextLink=await shop.checkout({...input,quoteId:next.quoteId})
  const paidAuth={request:new URLSearchParams(new URL(nextLink.checkoutUrl).hash.slice(1)).get('request'),accessToken:auth.accessToken}
  await pool.query('UPDATE ac_inventory_shop_checkouts SET state=$2 WHERE quote_id=$1',[next.quoteId,{buy:{status:'complete'}}])
  await assert.rejects(checkout.cancel(paidAuth),/PAID_ORDER_CANNOT_CANCEL/)
  console.log('PASS uncertain prompts block resend/cancel, known rejection unlocks unpaid cancellation, paid cancellation is refused and original intent history remains')

  assert(inventoryShopNativeLotMatches({item:'minecraft:oak_planks',count:8},{item:'oak_planks',count:8}))
  assert(!inventoryShopNativeLotMatches({item:'minecraft:stone',count:8},{item:'oak_planks',count:8}))
  assert(!inventoryShopNativeLotMatches({item:'minecraft:oak_planks',count:7},{item:'oak_planks',count:8}))
  console.log('PASS native namespaced resource receipts match exact catalog material and count without accepting another item or quantity')

  let confirmed=0
  const original={operationId:'fixture-original-mint',status:'preview',expiresAtMs:Date.now()-600000}
  const untouched=await inventoryShopCancellationOperation({status:async query=>{assert.equal(query.operationId,original.operationId);return original}},ownerId,{...original,status:'pending'},async()=>{confirmed++;throw Error('Expired untouched preview must never be confirmed')})
  assert.equal(untouched.untouched,true);assert.equal(confirmed,0);assert.equal(untouched.operation.operationId,original.operationId)
  const resumed=await inventoryShopCancellationOperation({status:async()=>({...original,status:'pending'})},ownerId,original,async current=>{confirmed++;return{...current,status:'complete'}})
  assert.equal(resumed.operation.operationId,original.operationId);assert.equal(resumed.operation.status,'complete');assert.equal(confirmed,1)
  console.log('PASS cancellation skips expired untouched original previews and resumes only consented original operation IDs')

  const recovery={quote_id:quote.quoteId,state:{merchantRedeem:original}},saved=[]
  let previews=0
  const fresh=await inventoryShopRecoveryPreview({status:async()=>original},ownerId,recovery,'merchantRedeem','merchant-return',async row=>saved.push(structuredClone(row)),async operationId=>{previews++;return{operationId,status:'preview',expiresAtMs:Date.now()+300000}})
  assert.equal(previews,1);assert.match(fresh.operationId,/:merchant-return:recovery-1$/)
  assert.equal(recovery.state.recoveryHistory[0].operationId,original.operationId)
  const pending={...fresh,status:'pending'}
  const retained=await inventoryShopRecoveryPreview({status:async()=>pending},ownerId,recovery,'merchantRedeem','merchant-return',async()=>{},async()=>{throw Error('Never replace a consented or unresolved operation')})
  assert.equal(retained.operationId,fresh.operationId);assert.equal(previews,1);assert.equal(recovery.state.merchantRedeemAttempt,1)
  console.log('PASS expired untouched redemption previews retain history and deterministic recovery IDs; consented pending operations are never replaced')
}finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()}
