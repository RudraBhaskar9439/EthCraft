import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {parseUnits,formatEther,formatUnits} from 'viem'
import {createWorldAssets} from '../world-assets/service.mjs'
import {createWorldAssetRegistrar} from '../world-assets/registrar.mjs'
import {loadPrivySettings,createTestnetWallets} from '../playable/testnet-wallets.mjs'
import {createUniswapMarket,validateMarketManifest} from '../playable/uniswap-market.mjs'
import {swapAmountRequest} from '../playable/swap-request.mjs'
import {createWorldAssetHealthPublisher} from '../world-assets/health-publisher.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const id=value=>{const h=createHash('sha256').update(String(value)).digest('hex');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-')}
const fail=code=>{throw Error(code)}
export async function createWorldAssetDiscordRuntime({rootDirectory,pool,identity,agents,native,service:injectedService,manifest:injectedManifest,wallets:injectedWallets,registrar:injectedRegistrar,payments:injectedPayments,publisher:injectedPublisher}={}){
 const consent=new AsyncLocalStorage()
 const manifest=injectedManifest||JSON.parse(await readFile(join(rootDirectory,'.local/world-assets/asset-market.json'),'utf8'))
 let wallets=injectedWallets,registrar=injectedRegistrar,payments=injectedPayments,service=injectedService,publisher=injectedPublisher,faucet,closed=false,lastSync=null,syncRunning=null
 if(!wallets){
  const loaded=await loadPrivySettings(rootDirectory)
  const targets=[manifest.registry,manifest.market,manifest.city,manifest.paymentManifest.router,manifest.paymentManifest.tokens.GEM.address]
  if(targets.some(address=>!loaded.settings.allowedTargets.some(target=>target.toLowerCase()===address.toLowerCase())))fail('WORLD_ASSET_PROVIDER_POLICY_SETUP_REQUIRED')
  wallets=await createTestnetWallets({pool,rootDirectory,provider:loaded.provider,environment:'UNICHAIN_SEPOLIA_PLAYABLE',chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,allowedTargets:loaded.settings.allowedTargets,allowBroadcast:loaded.settings.allowBroadcast===true,maxNativeBudgetWei:loaded.settings.maxNativeBudgetWei||'8000000000000000'})
 }
 async function resolveIdentity({principalId}){
  const link=(await pool.query('SELECT discord_user_id FROM ac_discord_identities WHERE principal_id=$1',[principalId])).rows[0]
  if(!link)fail('WORLD_ASSET_DISCORD_OWNER_REQUIRED')
  const owner=await identity.getOwner(link.discord_user_id)
  if(owner.ownerId!==principalId||!owner.privySubject||!UUID.test(owner.minecraftPlayerId||''))fail('WORLD_ASSET_VERIFIED_PROFILE_REQUIRED')
  const row=(await pool.query('SELECT address,auth_subject_hash FROM ac_playable_testnet_wallets WHERE wallet_id=$1',['UNICHAIN_SEPOLIA_PLAYABLE:'+principalId])).rows[0]
  if(!row||row.auth_subject_hash!==createHash('sha256').update(owner.privySubject).digest('hex'))fail('WORLD_ASSET_EXISTING_MANAGED_WALLET_REQUIRED')
  const agentInventories=[]
  for(const slot of agents.status().filter(slot=>slot.ownerId===principalId&&slot.connected)){
   const bot=agents.getBot(principalId),sourceId=bot?.player?.uuid||bot?.entity?.uuid||bot?._client?.uuid
   if(bot?.username===slot.name&&UUID.test(sourceId||''))agentInventories.push({agentId:slot.name,sourceId:sourceId.toLowerCase()})
  }
  return{principalId,discordUserId:owner.discordUserId,privySubject:owner.privySubject,minecraftPlayerId:owner.minecraftPlayerId,walletAddress:row.address,address:row.address,walletId:'UNICHAIN_SEPOLIA_PLAYABLE:'+principalId,agentInventories}
 }
 if(!registrar)registrar=await createWorldAssetRegistrar({rootDirectory,pool,manifest})
 if(!service)service=await createWorldAssets({pool,manifest,wallets,registrar,native,resolveIdentity,resolveWalletOwner:async({walletAddress})=>{
  const row=(await pool.query("SELECT i.principal_id FROM ac_playable_testnet_wallets w JOIN ac_discord_identities i ON w.wallet_id='UNICHAIN_SEPOLIA_PLAYABLE:'||i.principal_id::text WHERE lower(w.address)=lower($1) AND w.auth_subject_hash IS NOT NULL",[walletAddress])).rows[0]
  return row?{principalId:row.principal_id}:null
 },authorize:async request=>{const accepted=consent.getStore();return accepted?.principalId===request.principalId&&accepted?.operationId===request.operationId&&accepted?.termsDigest===request.termsDigest&&accepted?.confirmationId===request.confirmationId}})
 async function paymentService(){return payments||=await createUniswapMarket({pool,wallets,manifest:validateMarketManifest(manifest.paymentManifest)})}
 async function faucetService(){
  if(!faucet){const {createWorldAssetFaucet}=await import('../world-assets/faucet.mjs');faucet=await createWorldAssetFaucet({rootDirectory,pool,manifest,resolveIdentity,authorize:async request=>{
   const accepted=consent.getStore()
   if(accepted?.kind!=='faucet'||['principalId','operationId','termsDigest','confirmationId','discordUserId'].some(key=>accepted[key]!==request[key]))return{authorized:false}
   return{authorized:true,...request}
  }})}return faucet
 }
 async function owner(userId){const value=await identity.getOwner(userId);if(value.discordUserId!==userId||!UUID.test(value.ownerId||''))fail('WORLD_ASSET_VERIFIED_DISCORD_REQUIRED');return value}
 async function sync(){if(closed)return;if(syncRunning)return syncRunning;syncRunning=(async()=>{lastSync=await service.sync();if(lastSync?.status==='active'){if(!publisher&&!injectedService)publisher=await createWorldAssetHealthPublisher({rootDirectory,manifest,native});await publisher?.publish({projection:lastSync})}return lastSync})().finally(()=>{syncRunning=null});return syncRunning}
 const swapView = value => {
  const exactOutput = value.kind === 'exact_output'
  let message
  if (['expired','reverted'].includes(value.status)) {
   message = `Swap ${value.previewId}: ${value.status}. Review this retained operation before requesting a new quote.`
  } else if (value.status === 'confirmed') {
   const actual = value.proof?.swap?.amountInBaseUnits
   message = exactOutput
    ? `Confirmed on Unichain Sepolia: received exactly ${value.quotedOut} ${value.tokenOut}; ${actual === undefined ? 'see receipt for actual input' : 'spent '+formatUnits(BigInt(actual),18)+' '+value.tokenIn}. Asset purchases are confirmed separately.`
    : `Confirmed on Unichain Sepolia: ${value.amountIn} ${value.tokenIn} swapped. Asset purchases are confirmed separately.`
  } else {
   const amounts = exactOutput
    ? `receive exactly ${value.quotedOut} ${value.tokenOut}; estimated ${value.amountIn} ${value.tokenIn}, maximum ${value.maxAmountIn} ${value.tokenIn}`
    : `${value.amountIn} ${value.tokenIn} → approximately ${value.quotedOut} ${value.tokenOut}; minimum ${value.minimumOut}`
   message = `Swap ${value.previewId}: ${amounts}. Deadline ${new Date(value.deadline*1000).toISOString()}. Testnet gas is additional.`
  }
  return {message,swap:value,confirmation:!value.consented&&value.status==='preview'?{kind:'swap',operationId:value.previewId}:null}
 }

 const view=value=>({message:value.status==='preview'?'Review these exact testnet asset terms before confirming. Testnet gas is additional.':value.message||`Asset operation: ${value.status}.`,operation:{...value,maxNativeCostWei:manifest.maxNativeCostWei},confirmation:value.status==='complete'?null:{kind:'asset',operationId:value.operationId,termsDigest:value.termsDigest}})
 async function handleDiscord({userId,operationId,action,args={}}){
  if(action==='browse')return{message:'Confirmed blockchain assets. Prices use CITY test tokens.',...(await service.browse())}
  const account=await owner(userId),principalId=account.ownerId
  if(action==='owned')return{message:'Your confirmed blockchain assets.',...(await service.ownedAssets({principalId}))}
  if(action==='wallet'){
   const balances=await(await paymentService()).balances({playerId:principalId})
   return{message:`Managed testnet wallet ${balances.address}. Unichain Sepolia (1301): ${balances.tokens.CITY.amount} CITY, ${balances.tokens.GEM.amount} GEM and ${formatEther(BigInt(balances.nativeBalanceWei))} test ETH for gas. Use /assets action:fund in Discord for the one-time testnet grant.`,balances}
  }
  if(action==='parcels')return{message:'Estate parcel catalog. Registration requires confirmed availability; existing task plots and public areas are excluded.',catalog:await native('property/catalog')}
  if(action==='fund'){const result=await(await faucetService()).preview({principalId,operationId:id(operationId)});return{message:result.message||'Review the one-time faucet grant: 100 CITY and 0.0001 test ETH. These are disposable testnet funds.',operation:{...result,action:'faucet'},confirmation:result.status==='complete'?null:{kind:'faucet',operationId:result.operationId}}}
  if(action==='confirm_fund'){
   const api=await faucetService(),saved=await api.preview({principalId,operationId:args.operationId}),request={kind:'faucet',principalId,discordUserId:userId,operationId:saved.operationId,termsDigest:saved.termsDigest,confirmationId:operationId}
   const result=await consent.run(request,()=>api.confirm(request));return{message:result.message||'Testnet faucet grant: '+result.status,operation:{...result,action:'faucet'},confirmation:result.status==='complete'?null:{kind:'faucet',operationId:result.operationId}}
  }
  if(action==='confirm'||action==='retry'){
   const saved=await service.status({principalId,operationId:args.operationId})
   const request={principalId,operationId:saved.operationId,termsDigest:saved.termsDigest,confirmationId:operationId}
   const result=await consent.run(request,()=>service.confirm(request));await sync();return view(result)
  }
  if(action==='status')return view(await service.status({principalId,operationId:args.operationId}))
  if(action==='sync'){await sync();return{message:lastSync?.status==='active'?'Confirmed ownership permissions refreshed.':'Ownership projection is paused: '+lastSync?.reason}}
  if(action==='swap')return swapView(await(await paymentService()).preview({playerId:principalId,operationId:id(operationId),...swapAmountRequest(args),tokenIn:args.tokenIn||'GEM',tokenOut:args.tokenOut||'CITY'}))
  if(action==='confirm_swap'||action==='retry_swap')return swapView(await(await paymentService())[action==='confirm_swap'?'confirm':'retry']({playerId:principalId,previewId:args.operationId}))
  const base={principalId,operationId}
  if(['claim_land','snapshot'].includes(action)&&! /^[1-9][0-9]{0,3}$/.test(String(args.parcelId||'')))fail('WORLD_ASSET_CATALOG_PARCEL_REQUIRED')
  let result
  if(action==='register_item'){
   const sourceKind=args.source==='agent'?'agent_inventory':'player_inventory',slot=args.source==='agent'?agents.status().find(slot=>slot.ownerId===principalId):null
   if(slot&&(slot.mode==='task'||slot.tasks?.some(task=>!['complete','cancelled'].includes(task.status))||slot.workflow&&slot.workflow.status!=='complete'))fail('WORLD_ASSET_FINISH_AGENT_TASK_FIRST')
   result=await service.previewMint({...base,kind:'item',sourceKind,...(slot?{agentId:slot.name}:{}),selection:args.slot??'main_hand',count:args.count??1})
  }else if(action==='claim_land')result=await service.previewMint({...base,kind:'parcel',parcelId:Number(args.parcelId)})
  else if(action==='snapshot')result=await service.previewSnapshot({...base,tokenId:args.tokenId,parcelId:Number(args.parcelId)})
  else if(action==='list'){
   if(!/^[0-9]+(?:\.[0-9]{1,18})?$/.test(args.price||''))fail('WORLD_ASSET_CITY_PRICE_REQUIRED')
   result=await service.previewList({...base,tokenId:args.tokenId,priceBaseUnits:parseUnits(args.price,18).toString(),expiry:Math.floor(Date.now()/1000)+86400})
  }else if(action==='buy')result=await service.previewBuy({...base,tokenId:args.tokenId})
  else if(action==='cancel')result=await service.previewCancel({...base,tokenId:args.tokenId})
  else if(action==='redeem')result=await service.previewRedeem({...base,tokenId:args.tokenId})
  else fail('WORLD_ASSET_ACTION_UNSUPPORTED')
  return view(result)
 }
 return{handleDiscord,service,manifest,sync,get status(){return lastSync},async close(){closed=true;if(syncRunning)await syncRunning.catch(()=>{});await faucet?.close?.();await publisher?.close?.();await registrar.close?.()}}
}
