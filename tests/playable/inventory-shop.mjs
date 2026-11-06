// Isolated PostgreSQL and injected native-stock/checkout fixtures only.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { createInventoryShop } from '../../backend/src/playable/inventory-shop.mjs'

const environment=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='test_inventory_shop_'+randomUUID().replaceAll('-','')
const admin=new pg.Pool({connectionString:environment.databaseUrl,max:1})
const pool=new pg.Pool({connectionString:environment.databaseUrl,max:4,options:'-c search_path='+schema})
const playerId=randomUUID(),connectionId=randomUUID(),ownerId=randomUUID(),sourceId=randomUUID()
const session={online:true,playerId,connectionId,principalId:ownerId,playerName:'Micro',pendingAuthentication:false,authenticationKind:'discord_approved_local_profile'}
const owner={ownerId,ownerName:'micro',minecraftPlayerId:playerId,privySubject:'did:privy:fixture'}
let stock={sourceId,items:{oak_planks:32,cobblestone:8},fingerprint:'a'.repeat(64),observedAtMs:Date.now(),provenance:'operator_supplied_demo'}
const config={pool,identity:{getMinecraftOwner:async()=>owner},serverId:'fixture-server',gameSession:async()=>session,
  readStock:async()=>({...stock,observedAtMs:Date.now()}),prices:{oak_planks:'0.125',cobblestone:'0.25'}}
let created=false
try {
  await admin.query('CREATE SCHEMA '+schema);created=true
  const shop=await createInventoryShop(config),input={playerId,connectionId}
  const catalog=await shop.catalog(input)
  assert.equal(catalog.entries[0].available,32);assert.equal(catalog.paymentReady,false)
  assert.match(catalog.disclosure,/Mumbai scenery is not shop stock/)
  const quote=await shop.quote({...input,item:'oak_planks',count:8})
  assert.equal(quote.totalBaseUnits,'1000000000000000000');assert.equal(quote.totalCity,'1')
  assert(quote.expiresAtMs>Date.now()+9*60000&&quote.expiresAtMs<=Date.now()+10*60000+1000,'Review must allow wallet onboarding while remaining time-limited')
  assert.equal(quote.paid,false);assert.equal(quote.paymentReady,false)
  await assert.rejects(shop.checkout({...input,quoteId:quote.quoteId}),/SELF_CUSTODY_CHECKOUT_NOT_CONFIGURED/)
  console.log('PASS actual-stock catalog and exact quantity pricing; missing payment adapter never charges or claims delivery')

  await assert.rejects(shop.quote({...input,item:'oak_planks',count:64}),/INSUFFICIENT_STOCK/)
  await assert.rejects(shop.quote({...input,item:'oak_planks',count:65}),/ITEM_QUANTITY_REQUIRED/)
  await assert.rejects(shop.quote({...input,item:'oak_planks',count:1,totalCity:'0'}),/FIELDS_REQUIRED/)
  await assert.rejects(shop.catalog({...input,connectionId:randomUUID()}),/APPROVED_CONNECTION_REQUIRED/)
  session.pendingAuthentication=true
  await assert.rejects(shop.catalog(input),/APPROVED_CONNECTION_REQUIRED/)
  session.pendingAuthentication=false
  console.log('PASS unsupported quantity, insufficient real stock, caller price spoof and unapproved or changed connection are refused')

  let prepared=0
  const wired=await createInventoryShop({...config,prepareCheckout:async request=>{
    prepared++;return {...request,status:'awaiting_wallet',nativeCustodyConfirmed:true,nativeReceiptId:randomUUID(),
      checkoutUrl:'http://127.0.0.1:8789/inventory-shop/checkout#request=fixture-private-request'}
  }})
  const ready=await wired.quote({...input,item:'cobblestone',count:4})
  const checkout=await wired.checkout({...input,quoteId:ready.quoteId})
  assert.equal(checkout.status,'awaiting_wallet');assert.equal(checkout.paid,false)
  assert.deepEqual(await wired.checkout({...input,quoteId:ready.quoteId}),checkout);assert.equal(prepared,1)
  const orderId=randomUUID(),nonce='n'.repeat(43)
  const native=await createInventoryShop({...config,checkoutMode:'privy_game',prepareCheckout:async request=>({...request,mode:'privy_game',orderId,consentNonce:nonce,chainId:1301,paid:false,status:'wallet_required'})})
  const nativeQuote=await native.quote({...input,item:'oak_planks',count:4})
  const nativeOrder=await native.checkout({...input,quoteId:nativeQuote.quoteId})
  assert.equal(nativeOrder.mode,'privy_game');assert.equal(nativeOrder.orderId,orderId);assert.equal(nativeOrder.paid,false)
  assert.equal((await native.checkout({...input,quoteId:nativeQuote.quoteId})).orderId,orderId)
  await assert.rejects(wired.checkout({...input,quoteId:nativeQuote.quoteId}),/PRIVY_GAME_NOT_ENABLED/)
  const expired=await wired.quote({...input,item:'oak_planks',count:1})
  await pool.query("UPDATE ac_inventory_shop_quotes SET expires_at=now()-interval '1 second' WHERE quote_id=$1",[expired.quoteId])
  await assert.rejects(wired.checkout({...input,quoteId:expired.quoteId}),/FRESH_QUOTE_REQUIRED/)
  console.log('PASS Privy game checkout preserves its exact owner-bound order without a browser URL or payment claim')
  owner.ownerId=randomUUID()
  session.principalId=owner.ownerId
  await assert.rejects(wired.checkout({...input,quoteId:ready.quoteId}),/QUOTE_OWNER_REQUIRED/)
  console.log('PASS injected checkout retains original owner-bound wallet link on retry; it never reports payment success')
} finally {
  await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()
}
