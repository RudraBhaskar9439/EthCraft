// Isolated PostgreSQL plus injected chain/Privy/native fixtures. No API requests,
// real signatures, token transfers, Minecraft deliveries or spending occur here.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import pg from '../../backend/node_modules/pg/lib/index.js'
import {createInventoryShop} from '../../backend/src/playable/inventory-shop.mjs'
import {createInventoryShopGame,validateInventoryGameCall} from '../../backend/src/playable/inventory-shop-game.mjs'
import {digest} from '../../backend/src/world-assets/canonical.mjs'
import {cityAbi,assetMarketAbi,registryAbi} from '../../backend/src/world-assets/abis.mjs'
const {encodeFunctionData,keccak256,stringToHex}=createRequire(new URL('../../backend/package.json',import.meta.url))('viem')
const id=value=>{const h=createHash('sha256').update(String(value)).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
const stageId=(shown,stage)=>id(id(shown.operationId)+':'+stage)
const address=n=>'0x'+n.repeat(40),UNIT=10n**18n
const env=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='test_inventory_game_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:env.databaseUrl,max:1})
const pool=new pg.Pool({connectionString:env.databaseUrl,max:4,options:'-c search_path='+schema})
const ownerId=randomUUID(),playerId=randomUUID(),connectionId=randomUUID(),merchantId=randomUUID(),sellerPlayerId=randomUUID()
const owner={ownerId,ownerName:'micro',minecraftPlayerId:playerId,privySubject:'did:privy:gamefixture'}
const session={online:true,pendingAuthentication:false,principalId:ownerId,playerId,connectionId,playerName:'Micro',authenticationKind:'discord_approved_local_profile'}
const merchant={principalId:merchantId,minecraftPlayerId:sellerPlayerId,sourceId:sellerPlayerId,sourceKind:'player_inventory',walletAddress:address('1'),operatorSuppliedDemo:true}
const manifest={mode:'marketplace',chainId:1301,city:address('2'),worldAssets:{chainId:1301,city:address('2'),market:address('3'),registry:address('4'),maxGas:600000,maxNativeCostWei:'500000000000000'}}
const managedAddress=address('5'),walletId='UNICHAIN_SEPOLIA_PLAYABLE:'+ownerId
let cityBalance=0n,nativeBalance=0n,enrollments=0,assetsCreated=0,mints=0,lists=0,claimEffects=0,claimAttempts=0,inventoryOpen=true
let fundingCityEffects=0,fundingNativeEffects=0,fundingPreviews=0,failFundingAfterCity=true,failSigning=true
const prepared=new Map(),broadcasts=new Set(),operations=new Map()
let assetOptions,grant
const runtime={manifest,wallets:{settings:{actors:{Seller:{principalId:merchantId,wallet:{address:merchant.walletAddress}}}},
  client:{readContract:async()=>cityBalance,getBalance:async()=>nativeBalance},role:()=>({address:address('6')}),
  prepare:async()=>{},broadcast:async()=>{},reconcile:async()=>({status:'confirmed'})}}
const managed={provider:'privy',getOrCreate:async(principal,{subject})=>{
  assert.equal(principal,ownerId);assert.equal(subject,owner.privySubject);enrollments++
  await pool.query(`INSERT INTO ac_playable_testnet_wallets(wallet_id,environment,address,provider_type,provider_account_id,auth_subject_hash)
    VALUES($1,'UNICHAIN_SEPOLIA_PLAYABLE',$2,'privy','privy-fixture',$3) ON CONFLICT DO NOTHING`,[walletId,managedAddress,createHash('sha256').update(subject).digest('hex')])
  return{walletId,address:managedAddress,provider:'privy',chainId:1301}
},prepare:async input=>{
  assert.equal(input.subject,owner.privySubject);assert.equal(input.playerId,ownerId)
  assert.equal(input.limits.maxNativeCostWei,'30000000000000');assert.equal(input.value,0n)
  if(prepared.has(input.operationId))assert.equal(digest(prepared.get(input.operationId)),digest(input))
  else prepared.set(input.operationId,input)
  if(failSigning){failSigning=false;throw Error('FIXTURE_SIGNING_UNKNOWN')}
},broadcast:async input=>{assert.equal(input.subject,owner.privySubject);broadcasts.add(input.operationId)},
reconcile:async()=>({status:'confirmed',transactionHash:'0x'+'a'.repeat(64)})}
function preview(action,input,terms){
  if(operations.has(input.operationId))return structuredClone(operations.get(input.operationId))
  const shown={operationId:input.operationId,action,status:'preview',expiresAtMs:Date.now()+300000,terms,termsDigest:digest(terms),tokenId:action==='mint'?'1':input.tokenId}
  operations.set(input.operationId,structuredClone(shown));return shown
}
async function createAssets(options){
  assetOptions=options;assetsCreated++
  return{
    previewMint:async input=>preview('mint',input,{nativePreview:{item:'oak_planks',count:input.count}}),
    previewList:async input=>{assert.equal(input.priceBaseUnits,'10000000000000000');assert.equal(Number.isSafeInteger(input.expiry),true);return preview('list',input,{price:input.priceBaseUnits,expiry:input.expiry})},
    previewBuy:async input=>preview('buy',input,{listing:{price:'10000000000000000',seller:merchant.walletAddress,nonce:'1',ownershipNonce:'1',revision:'1'}}),
    previewRedeem:async input=>preview('redeem',input,{asset:{ownershipNonce:'2'},backing:{nativeListingId:id('mailbox')}}),
    status:async({operationId})=>structuredClone(operations.get(operationId)),
    confirm:async request=>{
      const shown=operations.get(request.operationId)
      assert.equal(await options.authorize({...request,action:shown.action}),true)
      if(shown.status==='complete')return structuredClone(shown)
      if(shown.action==='mint')mints++
      if(shown.action==='list')lists++
      if(['buy','redeem'].includes(shown.action)){
        const binding=await options.resolveIdentity({principalId:ownerId});assert.equal(binding.walletAddress,managedAddress)
        const calls=shown.action==='buy'?[
          ['city-approval',manifest.worldAssets.city,encodeFunctionData({abi:cityAbi,functionName:'approve',args:[manifest.worldAssets.market,10000000000000000n]})],
          ['buy',manifest.worldAssets.market,encodeFunctionData({abi:assetMarketAbi,functionName:'buy',args:[1n,merchant.walletAddress,10000000000000000n,1n,1n,1n]})]
        ]:[['request-redemption',manifest.worldAssets.registry,encodeFunctionData({abi:registryAbi,functionName:'requestRedemption',args:[1n,2n,keccak256(stringToHex(id(shown.operationId)+':claim'))]})]]
        for(const[stage,to,data]of calls){
          const operationId=stageId(shown,stage)
          await options.wallets.prepare({playerId:ownerId,operationId,to,data,value:0n,limits:{maxGas:600000,maxNativeCostWei:manifest.worldAssets.maxNativeCostWei}})
          await options.wallets.broadcast({playerId:ownerId,operationId});await options.wallets.reconcile({playerId:ownerId,operationId})
        }
      }
      shown.status='complete';return structuredClone(shown)
    }
  }
}
async function createFunding(options){
  async function shown(principalId){
    const bound=await options.resolveIdentity({principalId})
    assert.equal(bound.walletId,walletId);assert.equal(bound.nativeApproved,true);assert.equal(bound.managedWalletVerified,true)
    grant||={operationId:id('grant'),termsDigest:digest('grant'),status:'preview',consented:false,terms:{recipient:managedAddress,walletId,city:manifest.city,source:merchant.walletAddress,
      cityAmountBaseUnits:String(UNIT),nativeAmountWei:'100000000000000',chainId:1301,maximumGrants:1,operationIds:{grant:id('grant'),city:id('grant-city'),native:id('grant-native')}}}
    return structuredClone(grant)
  }
  return{preview:async({principalId})=>{fundingPreviews++;return shown(principalId)},confirm:async request=>{
    await shown(request.principalId)
    if(!grant.consented){
      const accepted=await options.authorize({kind:'privy-game-starter-grant',...request,operationId:grant.operationId,...grant.terms})
      assert.equal(accepted.authorized,true);grant.consented=true;grant.status='funding'
    }
    if(!grant.cityReceipt){fundingCityEffects++;cityBalance+=UNIT;grant.cityReceipt={fixture:true};if(failFundingAfterCity){failFundingAfterCity=false;throw Error('FIXTURE_GRANT_NATIVE_UNCERTAIN')}}
    if(!grant.nativeReceipt){fundingNativeEffects++;nativeBalance+=100000000000000n;grant.nativeReceipt={fixture:true}}
    grant.status='complete';return structuredClone(grant)
  }}
}
const config={pool,identity:{getMinecraftOwner:async()=>owner},serverId:'fixture-server',gameSession:async()=>session,native:async(path,input)=>{
  assert.equal(path,'escrow/claim');claimAttempts++
  if(inventoryOpen)throw Error('FIXTURE_OPEN_INVENTORY')
  claimEffects++;return{claimed:true,item:'oak_planks',count:1,ownerId:ownerId,playerId}
},getOperatorRuntime:async()=>runtime,getManagedWallets:async()=>managed,merchant,createAssets,createFunding}
const input={playerId,connectionId}
let created=false
try{
  await admin.query('CREATE SCHEMA '+schema);created=true
  await pool.query(`CREATE TABLE ac_playable_testnet_wallets(wallet_id text PRIMARY KEY,environment text,address text,provider_type text,provider_account_id text,auth_subject_hash text);
    CREATE TABLE ac_discord_wallet_aliases(wallet_id text PRIMARY KEY,principal_id uuid,address text,provider_account_id text);`)
  let game=await createInventoryShopGame(config)
  assert.equal(await game.latest(input),null)
  const shop=await createInventoryShop({pool,identity:config.identity,serverId:config.serverId,gameSession:config.gameSession,
    readStock:async()=>({sourceId:sellerPlayerId,items:{oak_planks:64},selections:{oak_planks:0},observedAtMs:Date.now(),fingerprint:'b'.repeat(64),provenance:'operator_supplied_demo'}),prices:{oak_planks:'0.01'},checkoutMode:'privy_game',prepareCheckout:game.open})
  const quote=await shop.quote({...input,item:'oak_planks',count:1}),opened=await shop.checkout({...input,quoteId:quote.quoteId})
  const orderInput={...input,orderId:opened.orderId}
  assert.equal(opened.status,'wallet_required');assert.equal(opened.paymentConsentRecorded,false);assert.equal(opened.fundingAvailable,false)
  // Minecraft copies the decoded top-level order with Map.copyOf, which rejects null values.
  assert.equal(Object.values(JSON.parse(JSON.stringify(opened))).includes(null),false,'Unfunded checkout must omit absent optional fields')
  assert.equal(opened.unitPriceCity,'0.01');assert.equal(opened.expiresAtMs,quote.expiresAtMs)
  await game.status(orderInput);assert.equal(enrollments,0);assert.equal(assetsCreated,0);assert.equal(prepared.size,0)
  await assert.rejects(game.status({...orderInput,connectionId:randomUUID()}),/APPROVED_CONNECTION_REQUIRED/)
  await assert.rejects(game.status({...orderInput,playerId:randomUUID()}),/ORDER_OWNER_REQUIRED/)
  console.log('PASS order/status are bound to the current approved Minecraft/Privy owner; no implicit enrollment, signing or escrow')

  const enrolled=await game.enroll(orderInput)
  assert.equal(enrolled.status,'insufficient_funds');assert.equal(enrolled.walletAddress,managedAddress);assert.equal(enrollments,1)
  assert.equal(enrolled.maxNativeFeeWei,'90000000000000');assert.equal(enrolled.fundingAvailable,true)
  const pay={...orderInput,consentNonce:enrolled.consentNonce,confirmationId:randomUUID()}
  await assert.rejects(game.confirm(pay),/INSUFFICIENT_FUNDS/)
  assert.equal((await pool.query('SELECT consent FROM ac_inventory_shop_game_orders WHERE order_id=$1',[opened.orderId])).rows[0].consent,null)
  assert.equal(assetsCreated,0);assert.equal(prepared.size,0)
  console.log('PASS insufficient CITY/gas records no Pay consent and permits only a separately explicit starter grant')

  await assert.rejects(game.fund({...pay,confirmationId:randomUUID()}),/FIXTURE_GRANT_NATIVE_UNCERTAIN/)
  assert.equal(fundingCityEffects,1);assert.equal(fundingNativeEffects,0);assert.equal(mints,0);assert.equal(prepared.size,0)
  // RPC balances can already show transfers before their canonical grant
  // receipts are retained. They must not unlock Pay or strand that grant.
  nativeBalance=100000000000000n
  await assert.rejects(game.confirm(pay),/ORIGINAL_STARTER_GRANT_PENDING/)
  assert.equal((await pool.query('SELECT consent FROM ac_inventory_shop_game_orders WHERE order_id=$1',[opened.orderId])).rows[0].consent,null)
  assert.equal(mints,0);assert.equal(prepared.size,0)
  const beforePendingLookup=fundingPreviews,pendingLookup=await game.latest(input)
  assert.equal(pendingLookup.orderId,opened.orderId);assert.equal(pendingLookup.status,'funding_pending')
  assert.equal(pendingLookup.consentNonce,enrolled.consentNonce);assert.equal(pendingLookup.paymentConsentRecorded,false)
  assert.equal(fundingPreviews,beforePendingLookup);assert.equal(fundingNativeEffects,0)
  nativeBalance=0n
  const funded=await game.status(orderInput)
  assert.equal(funded.starterGrant.status,'complete');assert.equal(funded.status,'ready');assert.equal(funded.paymentConsentRecorded,false)
  assert.notEqual(funded.consentNonce,enrolled.consentNonce);assert.equal(fundingCityEffects,1);assert.equal(fundingNativeEffects,1)
  const fundedAgain=await game.status(orderInput)
  assert.equal(fundedAgain.consentNonce,funded.consentNonce);assert.equal(fundingCityEffects,1);assert.equal(fundingNativeEffects,1)
  assert.equal(mints,0);assert.equal(prepared.size,0)
  await assert.rejects(game.confirm(pay),/EXPLICIT_PAYMENT_CONFIRMATION_REQUIRED/)
  console.log('PASS ambiguous Fund resumes the original grant only; one-time nonce rotation requires a fresh Pay click')

  const freshPay={...pay,consentNonce:funded.consentNonce,confirmationId:randomUUID()}
  await assert.rejects(game.confirm(freshPay),/FIXTURE_SIGNING_UNKNOWN/)
  assert.equal(mints,1);assert.equal(lists,1);assert.equal(prepared.size,1);assert.equal(broadcasts.size,0)
  game=await createInventoryShopGame(config)
  const newerUntouchedOrder=randomUUID()
  await pool.query(`INSERT INTO ac_inventory_shop_game_orders(order_id,quote_id,principal_id,player_id,connection_id,subject_hash,terms,wallet,consent_nonce,expires_at)
    SELECT $2,$3,principal_id,player_id,connection_id,subject_hash,terms,wallet,consent_nonce,now()+interval '1 hour'
    FROM ac_inventory_shop_game_orders WHERE order_id=$1`,[opened.orderId,newerUntouchedOrder,randomUUID()])
  session.connectionId=randomUUID();orderInput.connectionId=session.connectionId;freshPay.connectionId=session.connectionId
  const beforeResume={prepared:prepared.size,broadcasts:broadcasts.size,previews:fundingPreviews,assets:assetsCreated,native:fundingNativeEffects,city:fundingCityEffects}
  const recovered=await game.latest({...input,connectionId:session.connectionId})
  assert.equal(recovered.orderId,opened.orderId);assert.equal(recovered.consentNonce,funded.consentNonce)
  assert.equal(recovered.unitPriceCity,'0.01');assert.equal(recovered.expiresAtMs,quote.expiresAtMs)
  assert.equal(recovered.paymentConsentRecorded,true);assert.equal(recovered.paid,false)
  assert.deepEqual({prepared:prepared.size,broadcasts:broadcasts.size,previews:fundingPreviews,assets:assetsCreated,native:fundingNativeEffects,city:fundingCityEffects},beforeResume)
  assert.equal((await pool.query('SELECT connection_id FROM ac_inventory_shop_game_orders WHERE order_id=$1',[opened.orderId])).rows[0].connection_id,connectionId)
  await pool.query('DELETE FROM ac_inventory_shop_game_orders WHERE order_id=$1',[newerUntouchedOrder])
  await assert.rejects(game.latest(input),/APPROVED_CONNECTION_REQUIRED/)
  const paid=await game.status(orderInput)
  assert.equal(paid.paid,true);assert.equal(paid.deliveryConfirmed,false);assert.equal(paid.status,'ready_to_collect')
  assert.equal(paid.paymentConsentRecorded,true);assert.equal(paid.fundingAvailable,false)
  assert.equal(prepared.size,3);assert.equal(broadcasts.size,3);assert.equal(mints,1);assert.equal(lists,1)
  assert.equal(claimEffects,0);assert.equal(claimAttempts,1)
  const paidLookup=await game.latest({...input,connectionId:session.connectionId})
  assert.equal(paidLookup.orderId,opened.orderId);assert.equal(paidLookup.paid,true)
  assert.equal(prepared.size,3);assert.equal(broadcasts.size,3);assert.equal(claimAttempts,1)
  await assert.rejects(game.fund(freshPay),/PAYMENT_ALREADY_AUTHORIZED/)
  console.log('PASS restart resumes the original exact three managed-wallet calls with reduced gas caps; an open menu never claims delivery')

  inventoryOpen=false
  const delivered=await game.status(orderInput)
  assert.equal(delivered.status,'delivered');assert.equal(delivered.deliveryConfirmed,true);assert.equal(claimEffects,1)
  await game.status(orderInput)
  assert.equal(claimEffects,1);assert.equal(broadcasts.size,3);assert.equal(mints,1);assert.equal(lists,1)
  await pool.query(`INSERT INTO ac_inventory_shop_game_orders(order_id,quote_id,principal_id,player_id,connection_id,subject_hash,terms,wallet,consent_nonce,expires_at)
    SELECT $2,$3,principal_id,player_id,connection_id,subject_hash,terms,wallet,consent_nonce,now()-interval '1 hour'
    FROM ac_inventory_shop_game_orders WHERE order_id=$1`,[opened.orderId,randomUUID(),randomUUID()])
  assert.equal(await game.latest({...input,connectionId:session.connectionId}),null)
  console.log('PASS reconnect lookup recovers the original consented order ahead of newer untouched orders without writes/signing/grants; delivered and untouched expired orders are excluded')
  await pool.query("UPDATE ac_playable_testnet_wallets SET provider_account_id='changed' WHERE wallet_id=$1",[walletId])
  await assert.rejects(game.status(orderInput),/WALLET_BINDING_CHANGED/)
  await pool.query("UPDATE ac_playable_testnet_wallets SET provider_account_id='privy-fixture' WHERE wallet_id=$1",[walletId])
  await assert.rejects(pool.query("UPDATE ac_inventory_shop_game_orders SET consent=NULL WHERE order_id=$1",[opened.orderId]),/IMMUTABLE_ORDER/)
  console.log('PASS only an exact native delivery receipt completes an order; duplicate status, changed wallet bindings and consent reset remain safe')

  const row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[opened.orderId])).rows[0]
  const approval={operationId:stageId(row.state.buy,'city-approval'),to:manifest.worldAssets.city,value:0n,
    data:encodeFunctionData({abi:cityAbi,functionName:'approve',args:[manifest.worldAssets.market,10000000000000000n]})}
  validateInventoryGameCall(manifest.worldAssets,row,approval)
  assert.throws(()=>validateInventoryGameCall(manifest.worldAssets,row,{...approval,operationId:randomUUID()}),/METHOD_DENIED/)
  assert.throws(()=>validateInventoryGameCall(manifest.worldAssets,row,{...approval,value:1n}),/EXACT_CALL_REQUIRED/)
  assert.throws(()=>validateInventoryGameCall(manifest.worldAssets,row,{...approval,data:encodeFunctionData({abi:cityAbi,functionName:'approve',args:[manifest.worldAssets.market,UNIT]})}),/METHOD_DENIED/)
  const redemption={operationId:stageId(row.state.redeem,'request-redemption'),to:manifest.worldAssets.registry,value:0n,
    data:encodeFunctionData({abi:registryAbi,functionName:'requestRedemption',args:[1n,2n,keccak256(stringToHex(id(row.state.redeem.operationId)+':claim'))]})}
  validateInventoryGameCall(manifest.worldAssets,row,redemption)
  assert.throws(()=>validateInventoryGameCall(manifest.worldAssets,row,{...redemption,data:encodeFunctionData({abi:registryAbi,functionName:'requestRedemption',args:[1n,2n,'0x'+'0'.repeat(64)]})}),/METHOD_DENIED/)
  await assert.rejects(assetOptions.wallets.prepare({playerId:ownerId,...approval,limits:{maxGas:600000,maxNativeCostWei:'30000000000000'}}),/EXACT_PAYMENT_CONSENT_REQUIRED/)
  console.log('PASS exact operation IDs, CITY amounts, zero native value and the service-derived keccak redemption claim are enforced; out-of-scope signing is denied')
}finally{
  await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()
}
