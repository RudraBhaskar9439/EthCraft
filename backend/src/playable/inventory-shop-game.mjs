import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {decodeFunctionData,formatEther,formatUnits,keccak256,stringToHex} from 'viem'
import {createWorldAssets} from '../world-assets/service.mjs'
import {createWorldAssetStore} from '../world-assets/store.mjs'
import {digest,json,lower} from '../world-assets/canonical.mjs'
import {cityAbi,assetMarketAbi,registryAbi} from '../world-assets/abis.mjs'
import {inventoryShopNativeLotMatches,inventoryShopRecoveryPreview} from './inventory-shop-checkout.mjs'
import {createInventoryGameFunding} from './inventory-game-funding.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,TOKEN=/^[A-Za-z0-9_-]{43}$/
const CUMULATIVE_FEE_CAP=8000000000000000n
const GAME_TRANSACTION_CAP=30000000000000n
const fail=code=>{throw Object.assign(Error(code),{code})}
const hash=value=>createHash('sha256').update(value).digest('hex')
const operationId=value=>{const h=hash(value);return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-')}
// This is the world-assets service's durable operation/stage ID, including its UUID nibbles.
const assetId=value=>{const h=hash(String(value));return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
const stageId=(preview,stage)=>preview&&assetId(assetId(preview.operationId)+':'+stage)
const publicWallet=wallet=>wallet&&({walletId:wallet.wallet_id,address:lower(wallet.address),providerAccountId:wallet.provider_account_id})

export function validateInventoryGameCall(manifest,row,input){
  if(BigInt(input.value||0)!==0n||!UUID.test(input.operationId||''))fail('INVENTORY_SHOP_GAME_EXACT_CALL_REQUIRED')
  const target=lower(input.to),city=lower(manifest.city),market=lower(manifest.market),registry=lower(manifest.registry)
  if(![city,market,registry].includes(target))fail('INVENTORY_SHOP_GAME_METHOD_DENIED')
  let call
  try{call=decodeFunctionData({abi:target===city?cityAbi:target===market?assetMarketAbi:registryAbi,data:input.data})}catch{fail('INVENTORY_SHOP_GAME_METHOD_DENIED')}
  const args=call.args
  if(target===city&&call.functionName==='approve'&&input.operationId===stageId(row.state.buy,'city-approval')&&lower(args[0])===market&&String(args[1])===row.terms.totalBaseUnits)return
  if(target===market&&call.functionName==='buy'&&String(args[0])===String(row.state.mint?.tokenId)&&lower(args[1])===lower(row.terms.merchant.walletAddress)&&
    input.operationId===stageId(row.state.buy,'buy')&&String(args[2])===row.terms.totalBaseUnits&&['nonce','ownershipNonce','revision'].every((key,i)=>String(args[i+3])===String(row.state.buy?.terms.listing[key])))return
  if(target===registry&&call.functionName==='requestRedemption'&&String(args[0])===String(row.state.mint?.tokenId)&&String(args[1])===String(row.state.redeem?.terms.asset.ownershipNonce)&&
    input.operationId===stageId(row.state.redeem,'request-redemption')&&String(args[2]).toLowerCase()===keccak256(stringToHex(assetId(row.state.redeem.operationId)+':claim')).toLowerCase())return
  fail('INVENTORY_SHOP_GAME_METHOD_DENIED')
}

/** One GUI-confirmed order; signing uses the real user's separately enrolled Privy wallet. */
export async function createInventoryShopGame({pool,identity,serverId,gameSession,native,getOperatorRuntime,getManagedWallets,merchant,createAssets=createWorldAssets,createFunding=createInventoryGameFunding}={}){
  if(!pool?.query||!pool?.connect||typeof identity?.getMinecraftOwner!=='function'||!serverId||[gameSession,native,getOperatorRuntime,getManagedWallets].some(value=>typeof value!=='function')||
    !UUID.test(merchant?.principalId||'')||!UUID.test(merchant?.minecraftPlayerId||'')||merchant.sourceId!==merchant.minecraftPlayerId||merchant.sourceKind!=='player_inventory'||merchant.operatorSuppliedDemo!==true)fail('INVENTORY_SHOP_GAME_CONFIGURATION_REQUIRED')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_inventory_shop_game_orders(
    order_id uuid PRIMARY KEY,quote_id uuid NOT NULL UNIQUE,principal_id uuid NOT NULL,player_id uuid NOT NULL,
    connection_id uuid NOT NULL,subject_hash text NOT NULL,terms jsonb NOT NULL,wallet jsonb,consent_nonce text NOT NULL,
    consent jsonb,state jsonb NOT NULL DEFAULT '{}',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION protect_inventory_game_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (NEW.order_id,NEW.quote_id,NEW.principal_id,NEW.player_id,NEW.connection_id,NEW.subject_hash,NEW.terms,NEW.expires_at,NEW.created_at)
      IS DISTINCT FROM (OLD.order_id,OLD.quote_id,OLD.principal_id,OLD.player_id,OLD.connection_id,OLD.subject_hash,OLD.terms,OLD.expires_at,OLD.created_at)
      OR (OLD.wallet IS NOT NULL AND NEW.wallet IS DISTINCT FROM OLD.wallet)
      OR (OLD.consent IS NOT NULL AND (NEW.consent IS DISTINCT FROM OLD.consent OR NEW.consent_nonce IS DISTINCT FROM OLD.consent_nonce))
      OR (OLD.state->>'delivered'='true' AND NEW.state->>'delivered' IS DISTINCT FROM 'true')
      THEN RAISE EXCEPTION 'INVENTORY_SHOP_GAME_IMMUTABLE_ORDER'; END IF; RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS protect_inventory_game_order ON ac_inventory_shop_game_orders;
    CREATE TRIGGER protect_inventory_game_order BEFORE UPDATE ON ac_inventory_shop_game_orders FOR EACH ROW EXECUTE FUNCTION protect_inventory_game_order();`)
  const consent=new AsyncLocalStorage(),store=await createWorldAssetStore(pool)
  let runtime,managed,assets,funding,tail=Promise.resolve()
  const serialize=method=>input=>{const work=tail.catch(()=>{}).then(()=>method(input));tail=work.catch(()=>{});return work}
  const save=async row=>{await pool.query('UPDATE ac_inventory_shop_game_orders SET state=$2 WHERE order_id=$1',[row.order_id,json(row.state)])}
  const runtimeFor=async()=>{
    if(!runtime){runtime=await getOperatorRuntime();const actor=Object.values(runtime.wallets.settings.actors).find(value=>value.principalId===merchant.principalId)
      if(runtime.manifest.mode!=='marketplace'||runtime.manifest.chainId!==1301||!actor||lower(actor.wallet.address)!==lower(merchant.walletAddress)||runtime.manifest.worldAssets?.chainId!==1301)fail('INVENTORY_SHOP_GAME_CURRENT_MARKETPLACE_REQUIRED')}
    return runtime
  }
  async function current(playerId,connectionId,principalId){
    if(!UUID.test(playerId||'')||!UUID.test(connectionId||''))fail('INVENTORY_SHOP_GAME_CURRENT_CONNECTION_REQUIRED')
    const owner=await identity.getMinecraftOwner(serverId,playerId),session=await gameSession({serverId,playerId})
    if(!UUID.test(owner?.ownerId||'')||owner.minecraftPlayerId?.toLowerCase()!==playerId.toLowerCase()||!owner.privySubject||principalId&&owner.ownerId!==principalId||
      session?.online!==true||session.pendingAuthentication!==false||session.playerId?.toLowerCase()!==playerId.toLowerCase()||session.connectionId?.toLowerCase()!==connectionId.toLowerCase()||
      session.principalId!==owner.ownerId||session.playerName?.toLowerCase()!==owner.ownerName?.toLowerCase()||!['discord_approved_local_profile','minecraft_online_mode'].includes(session.authenticationKind)||session.serverId&&session.serverId!==serverId)fail('INVENTORY_SHOP_GAME_APPROVED_CONNECTION_REQUIRED')
    return{owner,session}
  }
  async function order(input){
    if(!UUID.test(input?.orderId||''))fail('INVENTORY_SHOP_GAME_ORDER_REQUIRED')
    const row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[input.orderId])).rows[0]
    if(!row||row.player_id!==input.playerId?.toLowerCase())fail('INVENTORY_SHOP_GAME_ORDER_OWNER_REQUIRED')
    const account=await current(input.playerId,input.connectionId,row.principal_id)
    if(hash(account.owner.privySubject)!==row.subject_hash)fail('INVENTORY_SHOP_GAME_ORDER_OWNER_REQUIRED')
    return{row,...account}
  }
  async function existingWallet(owner){
    if(!(await pool.query("SELECT to_regclass('ac_playable_testnet_wallets') AS table_name")).rows[0].table_name)return null
    const walletId='UNICHAIN_SEPOLIA_PLAYABLE:'+owner.ownerId
    const rows=(await pool.query(`SELECT w.*,a.address AS alias_address,a.provider_account_id AS alias_provider_account_id,a.principal_id
      FROM ac_playable_testnet_wallets w LEFT JOIN ac_discord_wallet_aliases a USING(wallet_id) WHERE w.wallet_id=$1`,[walletId])).rows
    if(!rows.length)return null
    const wallet=rows[0]
    if(rows.length!==1||wallet.environment!=='UNICHAIN_SEPOLIA_PLAYABLE'||wallet.provider_type!=='privy'||wallet.auth_subject_hash!==hash(owner.privySubject)||!wallet.provider_account_id)fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
    if(!wallet.principal_id)return null
    if(wallet.principal_id!==owner.ownerId||lower(wallet.alias_address)!==lower(wallet.address)||wallet.alias_provider_account_id!==wallet.provider_account_id)fail('INVENTORY_SHOP_GAME_WALLET_BINDING_CHANGED')
    return publicWallet(wallet)
  }
  async function walletFor(row,owner){
    const wallet=await existingWallet(owner)
    if(!row.wallet)return null
    if(!wallet||digest(wallet)!==digest(row.wallet))fail('INVENTORY_SHOP_GAME_WALLET_BINDING_CHANGED')
    return wallet
  }
  async function balances(row){
    const {wallets}=await runtimeFor(),client=wallets.client
    const [city,nativeBalance]=await Promise.all([client.readContract({address:runtime.manifest.worldAssets.city,abi:cityAbi,functionName:'balanceOf',args:[row.wallet.address]}),client.getBalance({address:row.wallet.address})])
    let reserved=0n
    if((await pool.query("SELECT to_regclass('ac_playable_testnet_requests') AS table_name")).rows[0].table_name){
      const requests=(await pool.query('SELECT unsigned_request FROM ac_playable_testnet_requests WHERE wallet_id=$1 AND unsigned_request IS NOT NULL',[row.wallet.walletId])).rows
      reserved=requests.reduce((sum,{unsigned_request:request})=>sum+BigInt(request.gas)*BigInt(request.maxFeePerGas)+BigInt(request.value||0),0n)
    }
    return{city:BigInt(city),native:BigInt(nativeBalance),remaining:CUMULATIVE_FEE_CAP>reserved?CUMULATIVE_FEE_CAP-reserved:0n}
  }
  async function view(row,owner,context={}){
    await walletFor(row,owner)
    const total=BigInt(row.terms.totalBaseUnits),count=BigInt(row.terms.count)
    if(count<1n||total%count!==0n)fail('INVENTORY_SHOP_GAME_EXACT_UNIT_PRICE_REQUIRED')
    let status=!row.wallet?'wallet_required':row.state.delivered?'delivered':row.state.redeem?.status==='complete'?'ready_to_collect':row.consent?'pending':'ready',balance
    const expired=!row.consent&&(+new Date(row.expires_at)<=Date.now()||context.connectionId&&context.connectionId.toLowerCase()!==row.connection_id)
    if(row.wallet){balance=await balances(row);if(!row.consent&&(balance.city<BigInt(row.terms.totalBaseUnits)||balance.native<BigInt(row.terms.maxNativeFeeWei)||balance.remaining<BigInt(row.terms.maxNativeFeeWei)))status='insufficient_funds'}
    if(expired)status='expired'
    if(row.state.fundingRequest&&row.state.funding?.status!=='complete')status='funding_pending'
    if(row.consent&&Object.values(row.state).some(value=>value?.status==='reverted'))status='reverted'
    const messages={wallet_required:'Create your own Privy-managed game wallet to continue. Your external wallet stays separate.',ready:'Review this exact order, then confirm the CITY purchase here.',
      insufficient_funds:'Your game wallet needs CITY and test ETH. Its address is shown below.',pending:'Your confirmed order is processing. Check this same order; do not create another purchase.',
      funding_pending:'Your original starter grant is not yet confirmed. Check this same order; Pay remains unavailable.',
      ready_to_collect:'Your purchase and redemption are confirmed. Close shop menus and collect your materials.',delivered:'Your exact purchased materials have been delivered.',expired:'This review expired. Review the same materials again before confirming.'}
    return{mode:'privy_game',orderId:row.order_id,quoteId:row.quote_id,principalId:row.principal_id,item:row.terms.item,count:row.terms.count,totalBaseUnits:row.terms.totalBaseUnits,
      totalCity:formatUnits(total,18),unitPriceCity:formatUnits(total/count,18),status,consentNonce:row.consent_nonce,walletAddress:row.wallet?.address,custody:'server_managed_privy_testnet',
      chainId:1301,maxNativeFeeWei:row.terms.maxNativeFeeWei,maxNativeFeeEth:formatEther(BigInt(row.terms.maxNativeFeeWei)),expiresAtMs:+new Date(row.expires_at),
      ...(balance?{cityBalance:formatUnits(balance.city,18),nativeBalanceWei:String(balance.native),remainingNativeBudgetWei:String(balance.remaining)}:{}),
      paymentConsentRecorded:Boolean(row.consent),fundingAvailable:await canFund(row,owner,expired,context),...(row.state.funding?{starterGrant:row.state.funding}:{}),
      gasDisclosure:'Wallet gas allowance for up to three buyer calls. Network data fees may also apply.',
      paid:row.state.buy?.status==='complete',delivered:Boolean(row.state.delivered),deliveryConfirmed:Boolean(row.state.delivered),
      message:row.state.message||messages[status]||(status==='reverted'?'An original transaction reverted. Keep this order for operator recovery; do not create another payment.':undefined)}
  }
  async function open(input){
    const quote=(await pool.query('SELECT * FROM ac_inventory_shop_quotes WHERE quote_id=$1',[input.quoteId])).rows[0]
    if(!quote||quote.principal_id!==input.principalId||quote.player_id!==input.playerId||quote.item!==input.item||quote.count!==input.count||quote.total_price!==input.totalBaseUnits||digest(quote.stock)!==digest(input.stock)||+new Date(quote.expires_at)!==input.expiresAtMs||input.stock?.sourceId!==merchant.sourceId||input.stock.provenance!=='operator_supplied_demo')fail('INVENTORY_SHOP_GAME_IMMUTABLE_QUOTE_REQUIRED')
    const {owner}=await current(quote.player_id,quote.connection_id,quote.principal_id),{manifest}=await runtimeFor(),fees=BigInt(manifest.worldAssets.maxNativeCostWei)
    const perTransaction=fees<GAME_TRANSACTION_CAP?fees:GAME_TRANSACTION_CAP
    const terms={item:quote.item,count:quote.count,totalBaseUnits:quote.total_price,stock:quote.stock,merchant,manifestDigest:digest(manifest.worldAssets),maxNativeFeeWei:String(perTransaction*3n),perTransactionFeeWei:String(perTransaction)}
    const wallet=await existingWallet(owner)
    await pool.query(`INSERT INTO ac_inventory_shop_game_orders(order_id,quote_id,principal_id,player_id,connection_id,subject_hash,terms,wallet,consent_nonce,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(quote_id) DO NOTHING`,[randomUUID(),quote.quote_id,owner.ownerId,quote.player_id,quote.connection_id,hash(owner.privySubject),json(terms),wallet,randomBytes(32).toString('base64url'),quote.expires_at])
    const row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE quote_id=$1',[quote.quote_id])).rows[0]
    if(row.principal_id!==owner.ownerId||row.subject_hash!==hash(owner.privySubject)||digest(row.terms)!==digest(terms))fail('INVENTORY_SHOP_GAME_IMMUTABLE_QUOTE_REQUIRED')
    return view(row,owner,{connectionId:input.connectionId})
  }
  async function enroll(input){
    let {row,owner}=await order(input)
    if(row.consent)fail('INVENTORY_SHOP_GAME_ORDER_ALREADY_CONFIRMED')
    if(+new Date(row.expires_at)<=Date.now()||row.connection_id!==input.connectionId.toLowerCase())fail('INVENTORY_SHOP_FRESH_QUOTE_REQUIRED')
    managed||=await getManagedWallets()
    if(managed.provider!=='privy')fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
    const created=await managed.getOrCreate(owner.ownerId,{subject:owner.privySubject}),walletId='UNICHAIN_SEPOLIA_PLAYABLE:'+owner.ownerId
    const record=(await pool.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1',[walletId])).rows[0]
    if(created.walletId!==walletId||created.provider!=='privy'||created.chainId!==1301||!record||record.provider_type!=='privy'||record.auth_subject_hash!==hash(owner.privySubject)||record.address!==lower(created.address)||!record.provider_account_id)fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
    await current(input.playerId,input.connectionId,owner.ownerId)
    await pool.query('INSERT INTO ac_discord_wallet_aliases(wallet_id,principal_id,address,provider_account_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[walletId,owner.ownerId,record.address,record.provider_account_id])
    const wallet=await existingWallet(owner)
    if(!wallet)fail('INVENTORY_SHOP_GAME_WALLET_BINDING_CHANGED')
    if(row.wallet&&digest(row.wallet)!==digest(wallet))fail('INVENTORY_SHOP_GAME_WALLET_BINDING_CHANGED')
    if(!row.wallet)await pool.query('UPDATE ac_inventory_shop_game_orders SET wallet=$2,consent_nonce=$3 WHERE order_id=$1 AND wallet IS NULL',[row.order_id,wallet,randomBytes(32).toString('base64url')])
    row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[row.order_id])).rows[0]
    return view(row,owner,{connectionId:input.connectionId})
  }

  async function scopedOwner(principalId){
    if(principalId===merchant.principalId)return{principalId,privySubject:'operator-controlled-test:'+principalId,
      minecraftPlayerId:merchant.minecraftPlayerId,walletAddress:lower(merchant.walletAddress)}
    const scope=consent.getStore(),row=scope?.row
    if(!row||row.principal_id!==principalId)fail('INVENTORY_SHOP_GAME_EXACT_ORDER_REQUIRED')
    const {owner}=await current(row.player_id,scope.connectionId,principalId),wallet=await walletFor(row,owner)
    if(!wallet)fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
    return{principalId,privySubject:owner.privySubject,minecraftPlayerId:row.player_id,walletAddress:wallet.address,
      walletId:wallet.walletId,nativeApproved:true,managedWalletVerified:true}
  }
  async function fundingService(){
    if(!funding){
      const {manifest,wallets}=await runtimeFor()
      funding=Promise.resolve(createFunding({pool,manifest,wallets,client:wallets.client,resolveIdentity:({principalId})=>scopedOwner(principalId),
        authorize:request=>{
          const accepted=consent.getStore()?.fundingApproval
          return accepted&&digest(accepted)===digest(request)?{authorized:true,...request}:{authorized:false}
        }})).catch(error=>{funding=null;throw error})
    }
    return funding
  }
  async function fundingPreview(row,owner,context={}){
    if(!row.wallet)return null
    const active=await gameSession({serverId,playerId:row.player_id})
    const scope={row,connectionId:context.connectionId||consent.getStore()?.connectionId||active.connectionId}
    return consent.run(scope,async()=>{
      await walletFor(row,owner)
      return(await fundingService()).preview({principalId:row.principal_id})
    })
  }
  async function canFund(row,owner,expired,context={}){
    if(!row.wallet||row.consent||expired||context.readOnly)return false
    try{
      const shown=await fundingPreview(row,owner,context)
      return shown?.status==='preview'&&!shown.consented&&!row.state.fundingRequest
    }catch(error){
      // A starter subsidy is optional and has one global pilot recipient. It
      // must never make an otherwise funded wallet unusable or bypass quota.
      if(/QUOTA|CONFIGURATION|BINDING_CONFLICT|GRANT/.test(error.code||error.message))return false
      throw error
    }
  }
  async function settleFunding(row,owner,input){
    if(!row.state.fundingRequest)return
    const request=row.state.fundingRequest
    const scope={row,connectionId:input.connectionId,fundingApproval:request}
    row.state.funding=await consent.run(scope,async()=>(await fundingService()).confirm(request))
    await save(row)
    if(row.state.funding.status==='complete'&&!row.consent&&!row.state.fundingNonceRotated){
      row.consent_nonce=randomBytes(32).toString('base64url');row.state.fundingNonceRotated=true
      row.state.message='Starter grant confirmed. Review the order and click Pay CITY separately to authorize this purchase.'
      await pool.query('UPDATE ac_inventory_shop_game_orders SET consent_nonce=$2,state=$3 WHERE order_id=$1 AND consent IS NULL',
        [row.order_id,row.consent_nonce,json(row.state)])
    }
  }
  async function fund(input){
    const {row,owner}=await order(input)
    if(row.consent)fail('INVENTORY_SHOP_GAME_PAYMENT_ALREADY_AUTHORIZED')
    if(row.connection_id!==input.connectionId.toLowerCase()||+new Date(row.expires_at)<=Date.now())fail('INVENTORY_SHOP_FRESH_QUOTE_REQUIRED')
    if(!TOKEN.test(input.consentNonce||'')||input.consentNonce!==row.consent_nonce||!UUID.test(input.confirmationId||''))fail('INVENTORY_SHOP_GAME_EXPLICIT_FUND_CONFIRMATION_REQUIRED')
    await walletFor(row,owner)
    if(!row.wallet)fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
    if(!row.state.fundingRequest){
      const shown=await fundingPreview(row,owner,{connectionId:input.connectionId})
      if(shown.consented||shown.status!=='preview')fail('INVENTORY_SHOP_GAME_ORIGINAL_STARTER_GRANT_REQUIRED')
      row.state.fundingRequest={kind:'privy-game-starter-grant',principalId:row.principal_id,operationId:shown.operationId,
        termsDigest:shown.termsDigest,confirmationId:input.confirmationId,...shown.terms}
      // Persist the explicit funding click before any remote signing. Status
      // can recover only these same two grant legs after an ambiguous reply.
      await save(row)
    }
    await settleFunding(row,owner,input)
    return view(row,owner,{connectionId:input.connectionId})
  }
  async function services(){
    if(assets)return assets
    const {manifest,wallets}=await runtimeFor(),limits=manifest.worldAssets
    async function buyer(input,prepare=false){
      const scope=consent.getStore(),row=scope?.row
      if(!row?.consent||row.principal_id!==input.playerId||row.consent.termsDigest!==digest(row.terms)||
        row.terms.manifestDigest!==digest(limits)||![stageId(row.state.buy,'city-approval'),stageId(row.state.buy,'buy'),stageId(row.state.redeem,'request-redemption')].includes(input.operationId))fail('INVENTORY_SHOP_GAME_EXACT_PAYMENT_CONSENT_REQUIRED')
      const owner=await scopedOwner(input.playerId)
      managed||=await getManagedWallets()
      if(managed.provider!=='privy')fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
      if(prepare)validateInventoryGameCall(limits,row,input)
      return{...input,subject:owner.privySubject,...(prepare?{limits:{maxGas:Number(limits.maxGas),maxNativeCostWei:row.terms.perTransactionFeeWei}}:{})}
    }
    const scopedWallets={
      prepare:async input=>input.playerId===merchant.principalId?wallets.prepare(input):managedPrepare(input),
      broadcast:async input=>input.playerId===merchant.principalId?wallets.broadcast(input):managedBroadcast(input),
      reconcile:async input=>input.playerId===merchant.principalId?wallets.reconcile(input):managedReconcile(input)
    }
    async function managedPrepare(input){const exact=await buyer(input,true);return managed.prepare(exact)}
    async function managedBroadcast(input){const exact=await buyer(input);return managed.broadcast(exact)}
    async function managedReconcile(input){const exact=await buyer(input);return managed.reconcile(exact)}
    assets=await createAssets({pool,store,manifest:limits,client:wallets.client,wallets:scopedWallets,registrar:wallets.role('registrar'),native,
      resolveIdentity:({principalId})=>scopedOwner(principalId),resolveWalletOwner:async({walletAddress})=>{
        if(lower(walletAddress)===lower(merchant.walletAddress))return{principalId:merchant.principalId}
        const row=consent.getStore()?.row
        return row?.wallet&&lower(walletAddress)===row.wallet.address?{principalId:row.principal_id}:null
      },authorize:request=>{
        const scope=consent.getStore(),accepted=scope?.approval
        return Boolean(scope?.row?.consent&&accepted&&['principalId','operationId','termsDigest','confirmationId'].every(key=>accepted[key]===request[key]))
      }})
    return assets
  }
  async function stage(row,input,principalId,shown){
    const request={principalId,operationId:shown.operationId,termsDigest:shown.termsDigest,
      confirmationId:operationId(row.order_id+':'+shown.action+':consent')}
    return consent.run({row,connectionId:input.connectionId,approval:request},async()=>(await services()).confirm(request))
  }
  async function advance(row,owner,input){
    if(!row.consent)return view(row,owner,{connectionId:input.connectionId})
    await walletFor(row,owner)
    const {manifest}=await runtimeFor()
    if(row.consent.kind!=='privy-game-inventory-purchase'||row.consent.principalId!==row.principal_id||row.consent.termsDigest!==digest(row.terms)||
      digest(row.consent.wallet)!==digest(row.wallet)||row.terms.manifestDigest!==digest(manifest.worldAssets))fail('INVENTORY_SHOP_GAME_EXACT_PAYMENT_CONSENT_REQUIRED')
    const api=await services(),merchantId=merchant.principalId
    const scoped=method=>consent.run({row,connectionId:input.connectionId},method)
    if(!row.state.mint){
      const selection=row.terms.stock.selections?.[row.terms.item]
      if(!Number.isInteger(selection)||selection<0||selection>35)fail('INVENTORY_SHOP_MERCHANT_STOCK_SLOT_REQUIRED')
      row.state.mint=await scoped(()=>api.previewMint({principalId:merchantId,operationId:'inventory-shop-game:'+row.order_id+':mint',
        kind:'item',sourceKind:'player_inventory',selection,count:row.terms.count}))
      if(!inventoryShopNativeLotMatches(row.state.mint.terms.nativePreview,row.terms))fail('INVENTORY_SHOP_EXACT_MERCHANT_ITEM_REQUIRED')
      await save(row)
    }
    row.state.mint=await stage(row,input,merchantId,row.state.mint);await save(row)
    if(row.state.mint.status!=='complete')return view(row,owner,{connectionId:input.connectionId})
    if(!row.state.list){
      row.state.list=await scoped(()=>api.previewList({principalId:merchantId,operationId:'inventory-shop-game:'+row.order_id+':list',
        tokenId:row.state.mint.tokenId,priceBaseUnits:row.terms.totalBaseUnits,expiry:Math.floor(+new Date(row.expires_at)/1000)+3600}));await save(row)
    }
    row.state.list=await stage(row,input,merchantId,row.state.list);await save(row)
    if(row.state.list.status!=='complete')return view(row,owner,{connectionId:input.connectionId})
    if(!row.state.buy){
      row.state.buy=await scoped(()=>api.previewBuy({principalId:row.principal_id,operationId:'inventory-shop-game:'+row.order_id+':buy',tokenId:row.state.mint.tokenId}))
      if(String(row.state.buy.terms.listing.price)!==row.terms.totalBaseUnits||lower(row.state.buy.terms.listing.seller)!==lower(merchant.walletAddress))fail('INVENTORY_SHOP_EXACT_LISTED_PRICE_REQUIRED')
      await save(row)
    }
    row.state.buy=await stage(row,input,row.principal_id,row.state.buy);await save(row)
    if(row.state.buy.status!=='complete')return view(row,owner,{connectionId:input.connectionId})
    row.state.redeem=await scoped(()=>inventoryShopRecoveryPreview(api,row.principal_id,row,'redeem','game-redeem',save,
      operationId=>api.previewRedeem({principalId:row.principal_id,operationId,tokenId:row.state.mint.tokenId})))
    row.state.redeem=await stage(row,input,row.principal_id,row.state.redeem);await save(row)
    if(row.state.redeem.status==='complete'&&!row.state.delivered){
      const {session}=await current(row.player_id,input.connectionId,row.principal_id)
      try{
        const receipt=await native('escrow/claim',{operationId:operationId(row.order_id+':claim'),mailboxId:row.state.redeem.terms.backing.nativeListingId,
          ownerId:row.principal_id,playerId:row.player_id,connectionId:session.connectionId})
        if(receipt.claimed!==true||!inventoryShopNativeLotMatches(receipt,row.terms)||receipt.ownerId!==row.principal_id||receipt.playerId!==row.player_id)fail('INVENTORY_SHOP_NATIVE_DELIVERY_PENDING')
        row.state.delivered=true;row.state.deliveryReceipt=receipt;delete row.state.message;await save(row)
      }catch(error){
        // A full inventory or open menu leaves the same paid mailbox claimable.
        // Delivery never follows from a payment receipt alone.
        row.state.message='Purchase confirmed. Close the menu and select Collect to receive this same paid order.';await save(row)
      }
    }
    return view(row,owner,{connectionId:input.connectionId})
  }
  async function confirm(input){
    let {row,owner}=await order(input)
    if(!row.consent){
      if(row.state.fundingRequest&&row.state.funding?.status!=='complete')fail('INVENTORY_SHOP_GAME_ORIGINAL_STARTER_GRANT_PENDING')
      if(row.connection_id!==input.connectionId.toLowerCase()||+new Date(row.expires_at)<=Date.now())fail('INVENTORY_SHOP_FRESH_QUOTE_REQUIRED')
      if(!TOKEN.test(input.consentNonce||'')||input.consentNonce!==row.consent_nonce||!UUID.test(input.confirmationId||''))fail('INVENTORY_SHOP_GAME_EXPLICIT_PAYMENT_CONFIRMATION_REQUIRED')
      await walletFor(row,owner)
      if(!row.wallet)fail('INVENTORY_SHOP_GAME_REAL_PRIVY_WALLET_REQUIRED')
      const balance=await balances(row),fee=BigInt(row.terms.maxNativeFeeWei)
      if(balance.city<BigInt(row.terms.totalBaseUnits)||balance.native<fee||balance.remaining<fee)fail('INVENTORY_SHOP_GAME_INSUFFICIENT_FUNDS')
      const accepted={kind:'privy-game-inventory-purchase',principalId:row.principal_id,termsDigest:digest(row.terms),
        wallet:row.wallet,consentNonce:row.consent_nonce,confirmationId:input.confirmationId,approvedAtMs:Date.now()}
      delete row.state.message
      await pool.query('UPDATE ac_inventory_shop_game_orders SET consent=$2,state=$3 WHERE order_id=$1 AND consent IS NULL',[row.order_id,json(accepted),json(row.state)])
      row=(await pool.query('SELECT * FROM ac_inventory_shop_game_orders WHERE order_id=$1',[row.order_id])).rows[0]
    }else if(input.consentNonce!==row.consent_nonce)fail('INVENTORY_SHOP_GAME_ORIGINAL_PAYMENT_REQUIRED')
    return advance(row,owner,input)
  }
  async function status(input){
    const {row,owner}=await order(input)
    if(row.state.fundingRequest){
      await settleFunding(row,owner,input)
      if(row.state.funding?.status!=='complete')return view(row,owner,{connectionId:input.connectionId})
    }
    if(row.consent)return advance(row,owner,input)
    return view(row,owner,{connectionId:input.connectionId})
  }
  async function latest(input){
    const {owner}=await current(input?.playerId,input?.connectionId)
    const row=(await pool.query(`SELECT * FROM ac_inventory_shop_game_orders
      WHERE principal_id=$1 AND player_id=$2 AND subject_hash=$3
        AND state->>'delivered' IS DISTINCT FROM 'true'
        AND (consent IS NOT NULL OR state ? 'fundingRequest' OR expires_at>now())
      ORDER BY CASE WHEN consent IS NOT NULL THEN 0
        WHEN state ? 'fundingRequest' AND state->'funding'->>'status' IS DISTINCT FROM 'complete' THEN 1 ELSE 2 END,
        created_at DESC LIMIT 1`,[owner.ownerId,input.playerId.toLowerCase(),hash(owner.privySubject)])).rows[0]
    return row?view(row,owner,{connectionId:input.connectionId,readOnly:true}):null
  }
  return{open:serialize(open),enroll:serialize(enroll),fund:serialize(fund),confirm:serialize(confirm),status:serialize(status),latest:serialize(latest)}
}
