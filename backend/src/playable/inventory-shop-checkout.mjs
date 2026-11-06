import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { formatUnits, getAddress, verifyMessage, toHex, decodeFunctionData } from 'viem'
import { createWorldAssets } from '../world-assets/service.mjs'
import { createWorldAssetStore } from '../world-assets/store.mjs'
import { digest, json, lower } from '../world-assets/canonical.mjs'
import {cityAbi,assetMarketAbi,registryAbi} from '../world-assets/abis.mjs'
import {createInventoryShopFunding,inventoryShopCityGrantStatus} from './inventory-shop-funding.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH=/^0x[a-f0-9]{64}$/i
const TOKEN=/^[A-Za-z0-9_-]{43}$/
const hash=value=>createHash('sha256').update(value).digest('hex')
const id=value=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
const fail=code=>{throw Object.assign(Error(code),{code})}
const origin='http://127.0.0.1:8789'
export const inventoryShopNativeLotMatches=(value,terms)=>typeof value?.item==='string'&&value.item.replace(/^minecraft:/,'')===terms.item&&value.count===terms.count
export async function inventoryShopCancellationOperation(api,principalId,preview,confirm){
  const current=await api.status({principalId,operationId:preview.operationId})
  if(current.status==='preview')return{operation:current,untouched:true}
  return{operation:current.status==='complete'?current:await confirm(current),untouched:false}
}
export async function inventoryShopRecoveryPreview(api,principalId,row,key,suffix,save,create){
  if(row.state[key]){
    const current=await api.status({principalId,operationId:row.state[key].operationId})
    if(current.status==='preview'&&current.expiresAtMs<=Date.now()){
      row.state.recoveryHistory||=[]
      row.state.recoveryHistory.push({action:key,operationId:current.operationId,reason:'untouched_preview_expired',expiresAtMs:current.expiresAtMs})
      row.state[key]=null;row.state[key+'Attempt']=(row.state[key+'Attempt']||0)+1;await save(row)
    }else row.state[key]=current
  }
  if(!row.state[key]){
    const attempt=row.state[key+'Attempt']||0
    row.state[key]=await create('inventory-shop:'+row.quote_id+':'+suffix+(attempt?':recovery-'+attempt:''));await save(row)
  }
  return row.state[key]
}

/** Browser-owned signatures only; no player keys or delegated Privy policies. */
export async function createInventoryShopCheckout({pool,identity,serverId,gameSession,verifyPrivyToken,native,
  getOperatorRuntime,merchant,expectedWallet='0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f'}={}) {
  if(!pool?.query||!pool?.connect||typeof identity?.getMinecraftOwner!=='function'||!serverId||
    [gameSession,verifyPrivyToken,native,getOperatorRuntime].some(value=>typeof value!=='function')||
    !UUID.test(merchant?.principalId||'')||!UUID.test(merchant?.minecraftPlayerId||'')||merchant?.sourceId!==merchant.minecraftPlayerId||
    merchant.sourceKind!=='player_inventory'||merchant.operatorSuppliedDemo!==true)fail('INVENTORY_SHOP_CHECKOUT_CONFIGURATION_REQUIRED')
  expectedWallet=lower(expectedWallet)
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_inventory_shop_checkouts(
    quote_id uuid PRIMARY KEY,capability text NOT NULL UNIQUE,principal_id uuid NOT NULL,player_id uuid NOT NULL,
    subject_hash text NOT NULL,terms jsonb NOT NULL,state jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS ac_inventory_shop_wallet_links(principal_id uuid PRIMARY KEY,subject_hash text NOT NULL,
    address text NOT NULL UNIQUE,message text NOT NULL,signature text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS ac_inventory_shop_wallet_challenges(quote_id uuid PRIMARY KEY,message text NOT NULL,
    address text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz);
    CREATE TABLE IF NOT EXISTS ac_inventory_shop_unsigned(operation_id uuid PRIMARY KEY,quote_id uuid NOT NULL,
    principal_id uuid NOT NULL,request jsonb NOT NULL,transaction_hash text UNIQUE,unknown_outcome boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now())`)
  const consent=new AsyncLocalStorage(),store=await createWorldAssetStore(pool)
  const orders=new Map()
  // shortcut: one loopback server serializes orders; add database fencing before multiple checkout hosts.
  const serialized=method=>async input=>{
    const {row}=await authenticated(input),previous=orders.get(row.quote_id)||Promise.resolve()
    const work=previous.catch(()=>{}).then(()=>method(input));orders.set(row.quote_id,work)
    try{return await work}finally{if(orders.get(row.quote_id)===work)orders.delete(row.quote_id)}
  }
  const active=row=>{if(row.state.cancelled||row.state.cancelRequested)fail('INVENTORY_SHOP_ORDER_CANCELLING_OR_CANCELLED')}
  let runtime,assets,funding
  const save=async row=>{await pool.query('UPDATE ac_inventory_shop_checkouts SET state=$2 WHERE quote_id=$1',[row.quote_id,json(row.state)])}
  async function current(playerId,principalId){
    const owner=await identity.getMinecraftOwner(serverId,playerId),session=await gameSession({serverId,playerId})
    if(owner.ownerId!==principalId||owner.minecraftPlayerId?.toLowerCase()!==playerId||!owner.privySubject||
      session?.online!==true||session.pendingAuthentication!==false||session.principalId!==principalId||
      session.playerId?.toLowerCase()!==playerId||session.playerName?.toLowerCase()!==owner.ownerName?.toLowerCase()||
      !['discord_approved_local_profile','minecraft_online_mode'].includes(session.authenticationKind)||
      !UUID.test(session.connectionId||'')||session.serverId&&session.serverId!==serverId)fail('INVENTORY_SHOP_CHECKOUT_APPROVED_CONNECTION_REQUIRED')
    return{owner,session}
  }
  async function authenticated(input){
    if(!TOKEN.test(input?.request||'')||typeof input.accessToken!=='string')fail('INVENTORY_SHOP_CHECKOUT_LOGIN_REQUIRED')
    const row=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE capability=$1',[input.request])).rows[0]
    if(!row)fail('INVENTORY_SHOP_CHECKOUT_REQUEST_REQUIRED')
    let claims
    try{claims=await verifyPrivyToken(input.accessToken)}catch{fail('INVENTORY_SHOP_CHECKOUT_LOGIN_REQUIRED')}
    const live=await current(row.player_id,row.principal_id)
    if(claims?.subject!==live.owner.privySubject||hash(claims.subject)!==row.subject_hash)fail('INVENTORY_SHOP_CHECKOUT_OWNER_REQUIRED')
    return{row,...live}
  }
  async function linked(row){
    const value=(await pool.query('SELECT * FROM ac_inventory_shop_wallet_links WHERE principal_id=$1',[row.principal_id])).rows[0]
    if(!value||value.subject_hash!==row.subject_hash||value.address!==expectedWallet)fail('INVENTORY_SHOP_WALLET_LINK_REQUIRED')
    return value
  }
  async function prepareCheckout(input){
    if(!UUID.test(input.quoteId||'')||!UUID.test(input.principalId||'')||!UUID.test(input.playerId||'')||input.stock?.sourceId!==merchant.sourceId||
      input.stock.provenance!=='operator_supplied_demo'||!Number.isInteger(input.count)||input.count<1||input.count>64||!/^[1-9][0-9]*$/.test(input.totalBaseUnits||''))fail('INVENTORY_SHOP_CHECKOUT_QUOTE_REQUIRED')
    const {owner}=await current(input.playerId,input.principalId)
    const terms={item:input.item,count:input.count,totalBaseUnits:input.totalBaseUnits,stock:input.stock}
    const capability=randomBytes(32).toString('base64url')
    await pool.query(`INSERT INTO ac_inventory_shop_checkouts(quote_id,capability,principal_id,player_id,subject_hash,terms)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[input.quoteId,capability,input.principalId,input.playerId,hash(owner.privySubject),terms])
    const row=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE quote_id=$1',[input.quoteId])).rows[0]
    if(row.principal_id!==input.principalId||row.player_id!==input.playerId||digest(row.terms)!==digest(terms))fail('INVENTORY_SHOP_CHECKOUT_IMMUTABLE_QUOTE_REQUIRED')
    return{quoteId:input.quoteId,principalId:input.principalId,item:terms.item,count:terms.count,totalBaseUnits:terms.totalBaseUnits,
      status:'wallet_link_required',nativeCustodyConfirmed:false,paid:false,checkoutUrl:origin+'/inventory-shop/checkout#request='+row.capability}
  }
  async function state(input){
    const {row}=await authenticated(input)
    const wallet=(await pool.query('SELECT address FROM ac_inventory_shop_wallet_links WHERE principal_id=$1 AND subject_hash=$2',[row.principal_id,row.subject_hash])).rows[0]
    const requests=(await pool.query('SELECT operation_id,request,transaction_hash,unknown_outcome FROM ac_inventory_shop_unsigned WHERE quote_id=$1 ORDER BY created_at',[row.quote_id])).rows
    const walletLinked=wallet?.address===expectedWallet
    const onboardingGrant=await inventoryShopCityGrantStatus(pool,row.principal_id,expectedWallet)
    const status=row.state.cancelled?'cancelled':row.state.cancelRequested?'returning_stock':row.state.delivered?'delivered':row.state.redeem?.status==='complete'?'ready_to_collect':row.state.buy?.status==='complete'?'purchased':row.state.list?.status==='complete'?'ready_to_pay':row.state.mint?'preparing_stock':walletLinked?'ready_to_prepare':'wallet_link_required'
    const messages={wallet_link_required:'Verify ownership of your designated wallet. This message signature spends no tokens.',
      ready_to_prepare:'Wallet verified. Prepare the exact backed resource lot for this order.',preparing_stock:'The original stock preparation is pending. Reconcile it; do not create a replacement order.',
      ready_to_pay:'Your exact resource lot is backed and listed. Review the CITY total, then approve each transaction in your wallet.',
      purchased:'CITY purchase confirmed. Request redemption to receive your exact materials.',ready_to_collect:'Redemption confirmed. Close Minecraft inventory menus and leave room before collecting.',delivered:'Your exact purchased materials were delivered to Minecraft.',
      returning_stock:'Your unpaid order is returning its original backed stock. Continue this cancellation until recovery is confirmed.',cancelled:'Unpaid order cancelled. Any prepared materials were returned to the original merchant inventory.'}
    return{quoteId:row.quote_id,item:row.terms.item,count:row.terms.count,totalCity:formatUnits(BigInt(row.terms.totalBaseUnits),18),
      totalBaseUnits:row.terms.totalBaseUnits,chainId:1301,expectedWallet,walletLinked,status,onboardingGrant,
      nativeCustodyConfirmed:row.state.mint?.status==='complete',paid:row.state.buy?.status==='complete',delivered:Boolean(row.state.delivered),
      cancelling:Boolean(row.state.cancelRequested),cancelled:Boolean(row.state.cancelled),
      transaction:requests.find(value=>!value.transaction_hash)||null,
      submitted:requests.filter(value=>value.transaction_hash).map(value=>({operationId:value.operation_id,hash:value.transaction_hash})),
      message:row.state.message||messages[status]}
  }
  async function challenge(input){
    const {row}=await authenticated(input)
    if(lower(input.address)!==expectedWallet)fail('INVENTORY_SHOP_DESIGNATED_WALLET_REQUIRED')
    const nonce=randomBytes(24).toString('hex'),expires=new Date(Date.now()+300000)
    const message=`AgentCity UniRock wallet link\nOrigin: ${origin}\nChain ID: 1301\nOrder: ${row.quote_id}\nWallet: ${getAddress(expectedWallet)}\nNonce: ${nonce}\nExpires: ${expires.toISOString()}\n\nLink this wallet to my Discord/Privy account for CITY testnet purchases. This message authorizes no transaction or token spend.`
    await pool.query(`INSERT INTO ac_inventory_shop_wallet_challenges(quote_id,message,address,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(quote_id) DO UPDATE SET message=$2,address=$3,expires_at=$4,consumed_at=NULL`,[row.quote_id,message,expectedWallet,expires])
    return{message,address:expectedWallet,expiresAtMs:+expires}
  }
  async function link(input){
    const {row}=await authenticated(input),tx=await pool.connect()
    try{
      await tx.query('BEGIN')
      const c=(await tx.query('SELECT * FROM ac_inventory_shop_wallet_challenges WHERE quote_id=$1 FOR UPDATE',[row.quote_id])).rows[0]
      if(!c||c.consumed_at||+new Date(c.expires_at)<=Date.now()||lower(input.address)!==c.address||!/^0x[0-9a-f]+$/i.test(input.signature||''))fail('INVENTORY_SHOP_WALLET_CHALLENGE_EXPIRED_OR_USED')
      if(!await verifyMessage({address:c.address,message:c.message,signature:input.signature}))fail('INVENTORY_SHOP_WALLET_SIGNATURE_INVALID')
      const prior=(await tx.query('SELECT * FROM ac_inventory_shop_wallet_links WHERE principal_id=$1 OR address=$2',[row.principal_id,c.address])).rows
      if(prior.some(value=>value.principal_id!==row.principal_id||value.subject_hash!==row.subject_hash||value.address!==c.address))fail('INVENTORY_SHOP_EXISTING_WALLET_BINDING_CONFLICT')
      await tx.query('INSERT INTO ac_inventory_shop_wallet_links(principal_id,subject_hash,address,message,signature) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.principal_id,row.subject_hash,c.address,c.message,input.signature])
      const bound=(await tx.query('SELECT principal_id,subject_hash,address FROM ac_inventory_shop_wallet_links WHERE principal_id=$1',[row.principal_id])).rows[0]
      if(!bound||bound.subject_hash!==row.subject_hash||bound.address!==c.address)fail('INVENTORY_SHOP_EXISTING_WALLET_BINDING_CONFLICT')
      await tx.query('UPDATE ac_inventory_shop_wallet_challenges SET consumed_at=now() WHERE quote_id=$1',[row.quote_id]);await tx.query('COMMIT')
      return{linked:true,address:c.address,spendingAuthorized:false}
    }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  async function services(){
    if(assets)return assets
    runtime=await getOperatorRuntime()
    const manifest=runtime.manifest.worldAssets,merchantActor=Object.values(runtime.wallets.settings.actors).find(value=>value.principalId===merchant.principalId)
    if(runtime.manifest.mode!=='marketplace'||runtime.manifest.chainId!==1301||!merchantActor||lower(merchantActor.wallet.address)!==lower(merchant.walletAddress))fail('INVENTORY_SHOP_MERCHANT_CONFIGURATION_REQUIRED')
    async function owner(principalId){
      if(principalId===merchant.principalId)return{principalId,privySubject:'operator-controlled-test:'+principalId,minecraftPlayerId:merchant.minecraftPlayerId,
        walletAddress:lower(merchant.walletAddress)}
      const record=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 1',[principalId])).rows[0]
      if(!record)fail('INVENTORY_SHOP_BROWSER_OWNER_REQUIRED')
      const account=await current(record.player_id,principalId),wallet=await linked(record)
      return{principalId,privySubject:account.owner.privySubject,minecraftPlayerId:record.player_id,walletAddress:wallet.address}
    }
    const browserWallets={
      async prepare(input){
        if(input.playerId===merchant.principalId)return runtime.wallets.prepare(input)
        const scope=consent.getStore(),account=await owner(input.playerId)
        if(!scope||scope.principalId!==input.playerId||!UUID.test(input.operationId||'')||BigInt(input.value||0)!==0n||
          ![manifest.city,manifest.market,manifest.registry].some(value=>lower(value)===lower(input.to)))fail('INVENTORY_SHOP_EXACT_BROWSER_TRANSACTION_REQUIRED')
        const order=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE quote_id=$1',[scope.quoteId])).rows[0]
        browserCall(manifest,order,input)
        const previous=(await pool.query('SELECT * FROM ac_inventory_shop_unsigned WHERE operation_id=$1',[input.operationId])).rows[0]
        if(previous){
          if(previous.principal_id!==input.playerId||previous.quote_id!==scope.quoteId||previous.request.from!==account.walletAddress||
            previous.request.to!==lower(input.to)||previous.request.data!==input.data||previous.request.value!=='0x0')fail('INVENTORY_SHOP_BROWSER_INTENT_CHANGED')
          return{operationId:input.operationId,status:previous.transaction_hash?'submitted':'awaiting_wallet'}
        }
        const estimate=await runtime.wallets.client.estimateGas({account:account.walletAddress,to:input.to,data:input.data,value:0n})
        const gas=(estimate*120n+99n)/100n,fees=await runtime.wallets.client.estimateFeesPerGas()
        if(gas>BigInt(input.limits.maxGas)||gas*fees.maxFeePerGas>BigInt(input.limits.maxNativeCostWei))fail('INVENTORY_SHOP_BROWSER_GAS_CAP')
        const request={chainId:'0x515',from:account.walletAddress,to:lower(input.to),data:input.data,value:'0x0',gas:toHex(gas),
          maxFeePerGas:toHex(fees.maxFeePerGas),maxPriorityFeePerGas:toHex(fees.maxPriorityFeePerGas)}
        await pool.query('INSERT INTO ac_inventory_shop_unsigned(operation_id,quote_id,principal_id,request) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.operationId,scope.quoteId,input.playerId,request])
        const saved=(await pool.query('SELECT * FROM ac_inventory_shop_unsigned WHERE operation_id=$1',[input.operationId])).rows[0]
        if(saved.principal_id!==input.playerId||saved.quote_id!==scope.quoteId||['from','to','data','value','chainId'].some(key=>saved.request[key]!==request[key]))fail('INVENTORY_SHOP_BROWSER_INTENT_CHANGED')
        return{operationId:input.operationId,status:saved.transaction_hash?'submitted':'awaiting_wallet'}
      },
      async broadcast(input){return this.reconcile(input)},
      async reconcile(input){
        if(input.playerId===merchant.principalId)return runtime.wallets.reconcile(input)
        const saved=(await pool.query('SELECT * FROM ac_inventory_shop_unsigned WHERE operation_id=$1 AND principal_id=$2',[input.operationId,input.playerId])).rows[0]
        if(!saved)fail('INVENTORY_SHOP_BROWSER_INTENT_REQUIRED')
        if(saved.transaction_hash){
          const row=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE quote_id=$1',[saved.quote_id])).rows[0]
          await checkedTransaction(saved,row)
        }
        return{status:saved.transaction_hash?'submitted':'awaiting_wallet',transactionHash:saved.transaction_hash}
      }
    }
    // Merchant broadcasts retain the existing finite operator gas ledger.
    browserWallets.broadcast=async input=>input.playerId===merchant.principalId?runtime.wallets.broadcast(input):browserWallets.reconcile(input)
    assets=await createWorldAssets({pool,store,manifest,client:runtime.wallets.client,wallets:browserWallets,registrar:runtime.wallets.role('registrar'),native,
      resolveIdentity:({principalId})=>owner(principalId),resolveWalletOwner:async({walletAddress})=>{
        if(lower(walletAddress)===lower(merchant.walletAddress))return{principalId:merchant.principalId}
        return(await pool.query('SELECT principal_id AS "principalId" FROM ac_inventory_shop_wallet_links WHERE address=$1',[lower(walletAddress)])).rows[0]||null
      },authorize:request=>{const accepted=consent.getStore();return accepted&&['principalId','operationId','termsDigest','confirmationId'].every(key=>accepted[key]===request[key])}})
    return assets
  }
  function browserCall(manifest,row,input){
    const target=lower(input.to),city=lower(manifest.city),market=lower(manifest.market),registry=lower(manifest.registry)
    let call
    try{call=decodeFunctionData({abi:target===city?cityAbi:target===market?assetMarketAbi:registryAbi,data:input.data})}catch{fail('INVENTORY_SHOP_BROWSER_METHOD_DENIED')}
    const args=call.args
    if(target===city&&call.functionName==='approve'&&lower(args[0])===market&&String(args[1])===row.terms.totalBaseUnits)return
    if(target===market&&call.functionName==='buy'&&String(args[0])===String(row.state.mint?.tokenId)&&lower(args[1])===lower(merchant.walletAddress)&&
      String(args[2])===row.terms.totalBaseUnits&&['nonce','ownershipNonce','revision'].every((key,index)=>String(args[index+3])===String(row.state.buy?.terms.listing[key])))return
    if(target===registry&&call.functionName==='requestRedemption'&&String(args[0])===String(row.state.mint?.tokenId)&&String(args[1])===String(row.state.redeem?.terms.asset.ownershipNonce))return
    fail('INVENTORY_SHOP_BROWSER_METHOD_DENIED')
  }
  async function checkedTransaction(saved,row){
    await services();await assets.reader.verify()
    const wallet=await linked(row)
    let tx
    try{tx=await runtime.wallets.client.getTransaction({hash:saved.transaction_hash})}catch{fail('INVENTORY_SHOP_TRANSACTION_RECONCILIATION_PENDING')}
    browserCall(runtime.manifest.worldAssets,row,{to:saved.request.to,data:saved.request.data})
    const limits=runtime.manifest.worldAssets
    if(lower(tx.from)!==wallet.address||lower(tx.to)!==saved.request.to||tx.input.toLowerCase()!==saved.request.data.toLowerCase()||BigInt(tx.value)!==0n||
      tx.chainId&&Number(tx.chainId)!==1301||BigInt(tx.gas)>BigInt(limits.maxGas)||BigInt(tx.gas)*BigInt(tx.maxFeePerGas??tx.gasPrice)>BigInt(limits.maxNativeCostWei))fail('INVENTORY_SHOP_SIGNED_TRANSACTION_MISMATCH')
    await pool.query('UPDATE ac_inventory_shop_unsigned SET unknown_outcome=false WHERE operation_id=$1 AND transaction_hash=$2',[saved.operation_id,saved.transaction_hash])
    return tx
  }
  async function confirm(row,principalId,preview){
    const api=await services(),request={quoteId:row.quote_id,principalId,operationId:preview.operationId,termsDigest:preview.termsDigest,confirmationId:id(row.quote_id+':'+preview.action+':consent')}
    return consent.run(request,()=>api.confirm(request))
  }
  async function fund(input){
    const {row}=await authenticated(input);active(row);await linked(row);await services()
    if(!funding)funding=createInventoryShopFunding({pool,manifest:runtime.manifest,wallets:runtime.wallets,client:runtime.wallets.client,
      resolveIdentity:async({principalId})=>{
        const record=(await pool.query('SELECT * FROM ac_inventory_shop_checkouts WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 1',[principalId])).rows[0]
        if(!record)fail('INVENTORY_SHOP_FUNDING_OWNER_REQUIRED')
        const {owner}=await current(record.player_id,principalId),wallet=await linked(record)
        return{principalId,privySubject:owner.privySubject,walletAddress:wallet.address,nativeApproved:true,walletSignatureVerified:true}
      },authorize:request=>{
        const scope=consent.getStore()
        return scope?.kind==='test-city-onboarding'&&['principalId','operationId','termsDigest','confirmationId'].every(key=>scope[key]===request[key])?{authorized:true,...request}:{authorized:false}
      }}).catch(error=>{funding=null;throw error})
    const grant=await funding,preview=await grant.preview({principalId:row.principal_id})
    const request={kind:'test-city-onboarding',principalId:row.principal_id,operationId:preview.operationId,termsDigest:preview.termsDigest,confirmationId:id('inventory-shop:test-city-onboarding:'+row.principal_id)}
    return consent.run(request,()=>grant.confirm(request))
  }
  async function prepare(input){
    const {row}=await authenticated(input);active(row);await linked(row);const api=await services()
    if(row.terms.stock.sourceId!==merchant.sourceId)fail('INVENTORY_SHOP_MERCHANT_STOCK_CHANGED')
    const selection=row.terms.stock.selections?.[row.terms.item]
    if(!Number.isInteger(selection)||selection<0||selection>35)fail('INVENTORY_SHOP_MERCHANT_STOCK_SLOT_REQUIRED')
    row.state.mint ||= await api.previewMint({principalId:merchant.principalId,operationId:'inventory-shop:'+row.quote_id+':mint',kind:'item',sourceKind:'player_inventory',selection,count:row.terms.count})
    if(!inventoryShopNativeLotMatches(row.state.mint.terms.nativePreview,row.terms))fail('INVENTORY_SHOP_EXACT_MERCHANT_ITEM_REQUIRED')
    await save(row);row.state.mint=await confirm(row,merchant.principalId,row.state.mint);await save(row)
    if(row.state.mint.status==='complete'){
      row.state.list ||= await api.previewList({principalId:merchant.principalId,operationId:'inventory-shop:'+row.quote_id+':list',tokenId:row.state.mint.tokenId,priceBaseUnits:row.terms.totalBaseUnits,expiry:Math.floor(+new Date(row.created_at)/1000)+86400})
      await save(row);row.state.list=await confirm(row,merchant.principalId,row.state.list);await save(row)
    }
    return state(input)
  }
  async function buy(input){
    const {row}=await authenticated(input);active(row);await linked(row);const api=await services()
    if(row.state.list?.status!=='complete')fail('INVENTORY_SHOP_BACKED_LISTING_REQUIRED')
    row.state.buy ||= await api.previewBuy({principalId:row.principal_id,operationId:'inventory-shop:'+row.quote_id+':buy',tokenId:row.state.mint.tokenId})
    if(String(row.state.buy.terms.listing.price)!==row.terms.totalBaseUnits||lower(row.state.buy.terms.listing.seller)!==lower(merchant.walletAddress))fail('INVENTORY_SHOP_EXACT_LISTED_PRICE_REQUIRED')
    await save(row);row.state.buy=await confirm(row,row.principal_id,row.state.buy);await save(row);return state(input)
  }
  async function redeem(input){
    const {row}=await authenticated(input);active(row);await linked(row);const api=await services()
    if(row.state.buy?.status!=='complete')fail('INVENTORY_SHOP_CONFIRMED_PURCHASE_REQUIRED')
    row.state.redeem=await inventoryShopRecoveryPreview(api,row.principal_id,row,'redeem','redeem',save,operationId=>api.previewRedeem({principalId:row.principal_id,operationId,tokenId:row.state.mint.tokenId}))
    await save(row);row.state.redeem=await confirm(row,row.principal_id,row.state.redeem);await save(row);return state(input)
  }
  async function submitted(input){
    const {row}=await authenticated(input);await linked(row)
    if(!UUID.test(input.operationId||'')||!HASH.test(input.transactionHash||''))fail('INVENTORY_SHOP_TRANSACTION_HASH_REQUIRED')
    const saved=(await pool.query('SELECT * FROM ac_inventory_shop_unsigned WHERE operation_id=$1 AND quote_id=$2 AND principal_id=$3',[input.operationId,row.quote_id,row.principal_id])).rows[0]
    if(!saved||saved.transaction_hash&&saved.transaction_hash.toLowerCase()!==input.transactionHash.toLowerCase())fail('INVENTORY_SHOP_ORIGINAL_TRANSACTION_REQUIRED')
    // Persist the reported hash before RPC reconciliation; an unavailable RPC
    // must not tempt the browser into sending the same payment again.
    await pool.query('UPDATE ac_inventory_shop_unsigned SET transaction_hash=$2 WHERE operation_id=$1 AND transaction_hash IS NULL',[input.operationId,input.transactionHash.toLowerCase()])
    const retained=(await pool.query('SELECT transaction_hash FROM ac_inventory_shop_unsigned WHERE operation_id=$1',[input.operationId])).rows[0]
    if(retained.transaction_hash!==input.transactionHash.toLowerCase())fail('INVENTORY_SHOP_ORIGINAL_TRANSACTION_REQUIRED')
    await checkedTransaction({...saved,transaction_hash:retained.transaction_hash},row)
    return{recorded:true,confirmed:false,message:'Original transaction recorded. Continue the same purchase to check canonical confirmation.'}
  }
  async function unknown(input){
    const {row}=await authenticated(input);active(row)
    if(!UUID.test(input.operationId||''))fail('INVENTORY_SHOP_BROWSER_INTENT_REQUIRED')
    const saved=await pool.query('UPDATE ac_inventory_shop_unsigned SET unknown_outcome=true WHERE operation_id=$1 AND quote_id=$2 AND principal_id=$3 AND transaction_hash IS NULL AND unknown_outcome=false',[input.operationId,row.quote_id,row.principal_id])
    if(saved.rowCount!==1)fail('INVENTORY_SHOP_BROWSER_INTENT_REQUIRED')
    return{status:'unknown',message:'Do not send again. Find the original transaction in your wallet and record its hash.'}
  }
  async function rejected(input){
    const {row}=await authenticated(input)
    if(!UUID.test(input.operationId||''))fail('INVENTORY_SHOP_BROWSER_INTENT_REQUIRED')
    const result=await pool.query('UPDATE ac_inventory_shop_unsigned SET unknown_outcome=false WHERE operation_id=$1 AND quote_id=$2 AND principal_id=$3 AND transaction_hash IS NULL AND unknown_outcome=true',[input.operationId,row.quote_id,row.principal_id])
    if(result.rowCount!==1)fail('INVENTORY_SHOP_BROWSER_INTENT_REQUIRED')
    return{status:'wallet_rejected',message:'Wallet request rejected. The original unsigned order remains available; no payment is claimed.'}
  }
  async function cancel(input){
    const {row}=await authenticated(input)
    if(row.state.cancelled)return state(input)
    if(row.state.buy?.status==='complete'||row.state.redeem||row.state.delivered)fail('INVENTORY_SHOP_PAID_ORDER_CANNOT_CANCEL')
    const requests=(await pool.query('SELECT * FROM ac_inventory_shop_unsigned WHERE quote_id=$1',[row.quote_id])).rows
    for(const request of requests){
      if(!request.transaction_hash){if(request.unknown_outcome)fail('INVENTORY_SHOP_UNRESOLVED_BUYER_TRANSACTION');continue}
      await checkedTransaction(request,row)
      const client=runtime.wallets.client
      let receipt
      try{receipt=await client.getTransactionReceipt({hash:request.transaction_hash})}catch{fail('INVENTORY_SHOP_UNRESOLVED_BUYER_TRANSACTION')}
      const head=await client.getBlockNumber({cacheTime:0}),canonical=await client.getBlock({blockNumber:receipt.blockNumber})
      if(head<BigInt(receipt.blockNumber)+1n||canonical.hash.toLowerCase()!==receipt.blockHash.toLowerCase())fail('INVENTORY_SHOP_UNRESOLVED_BUYER_TRANSACTION')
      if(receipt.status==='success'&&lower(request.request.to)===lower(runtime.manifest.worldAssets.market))fail('INVENTORY_SHOP_PAID_ORDER_CANNOT_CANCEL')
    }
    row.state.cancelRequested=true;await save(row)
    if(row.state.mint){
      const api=await services()
      const mint=await inventoryShopCancellationOperation(api,merchant.principalId,row.state.mint,preview=>confirm(row,merchant.principalId,preview))
      row.state.mint=mint.operation;await save(row)
      if(mint.untouched){row.state.mintPreviewAbandoned=true;row.state.cancelled=true;row.state.cancelRequested=false;await save(row);return state(input)}
      if(row.state.mint.status!=='complete')return state(input)
      if(row.state.list){
        const listing=await inventoryShopCancellationOperation(api,merchant.principalId,row.state.list,preview=>confirm(row,merchant.principalId,preview))
        row.state.list=listing.operation;await save(row)
        if(!listing.untouched){
          if(row.state.list.status!=='complete')return state(input)
          row.state.cancelListing=await inventoryShopRecoveryPreview(api,merchant.principalId,row,'cancelListing','cancel-listing',save,operationId=>api.previewCancel({principalId:merchant.principalId,operationId,tokenId:row.state.mint.tokenId}))
          await save(row);row.state.cancelListing=await confirm(row,merchant.principalId,row.state.cancelListing);await save(row)
          if(row.state.cancelListing.status!=='complete')return state(input)
        }else{row.state.listPreviewAbandoned=true;await save(row)}
      }
      row.state.merchantRedeem=await inventoryShopRecoveryPreview(api,merchant.principalId,row,'merchantRedeem','merchant-return',save,operationId=>api.previewRedeem({principalId:merchant.principalId,operationId,tokenId:row.state.mint.tokenId}))
      await save(row);row.state.merchantRedeem=await confirm(row,merchant.principalId,row.state.merchantRedeem);await save(row)
      if(row.state.merchantRedeem.status!=='complete')return state(input)
      const merchantSession=await gameSession({serverId,playerId:merchant.minecraftPlayerId})
      if(merchantSession.online!==true||merchantSession.pendingAuthentication!==false||merchantSession.principalId!==merchant.principalId||!UUID.test(merchantSession.connectionId||''))fail('INVENTORY_SHOP_MERCHANT_OFFLINE_OR_UNAPPROVED')
      const receipt=await native('escrow/claim',{operationId:id(row.quote_id+':merchant-stock-return'),mailboxId:row.state.merchantRedeem.terms.backing.nativeListingId,
        ownerId:merchant.principalId,playerId:merchant.minecraftPlayerId,connectionId:merchantSession.connectionId})
      if(receipt.claimed!==true||!inventoryShopNativeLotMatches(receipt,row.terms)||receipt.ownerId!==merchant.principalId||receipt.playerId!==merchant.minecraftPlayerId)fail('INVENTORY_SHOP_MERCHANT_STOCK_RETURN_PENDING')
      row.state.merchantReturnReceipt=receipt
    }
    row.state.cancelled=true;row.state.cancelRequested=false;await save(row);return state(input)
  }
  async function claim(input){
    const {row,session}=await authenticated(input);active(row)
    if(row.state.redeem?.status!=='complete')fail('INVENTORY_SHOP_CANONICAL_REDEMPTION_REQUIRED')
    const receipt=await native('escrow/claim',{operationId:id(row.quote_id+':claim'),mailboxId:row.state.redeem.terms.backing.nativeListingId,
      ownerId:row.principal_id,playerId:row.player_id,connectionId:session.connectionId})
    if(receipt.claimed!==true||!inventoryShopNativeLotMatches(receipt,row.terms)||receipt.ownerId!==row.principal_id||receipt.playerId!==row.player_id)fail('INVENTORY_SHOP_NATIVE_DELIVERY_PENDING')
    row.state.delivered=true;row.state.deliveryReceipt=receipt;await save(row);return state(input)
  }
  return{prepareCheckout,state,challenge:serialized(challenge),link:serialized(link),fund:serialized(fund),prepare:serialized(prepare),buy:serialized(buy),redeem:serialized(redeem),submitted:serialized(submitted),unknown:serialized(unknown),rejected:serialized(rejected),cancel:serialized(cancel),claim:serialized(claim)}
}
