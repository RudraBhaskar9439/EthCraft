import {readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import checkpoints from '../bot/checkpoint-store.cjs'
import {loadPrivySettings,createTestnetWallets} from './testnet-wallets.mjs'
import {createPrivyTokenVerifier} from './wallet-auth.mjs'
import {createBankLaptopRuntime} from '../bank/laptop-runtime.mjs'
import {createInventoryShop} from './inventory-shop.mjs'
import {createInventoryShopCheckout} from './inventory-shop-checkout.mjs'
import {createInventoryShopGame} from './inventory-shop-game.mjs'
import {createAgentShop} from './agent-shop.mjs'
import {timingSafeEqual} from 'node:crypto'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}
const json=async file=>JSON.parse(await readFile(file,'utf8'))
export const inventoryShopPrices=Object.freeze(Object.fromEntries(['oak_planks','cobblestone','stone','dirt','sand','oak_log','stick','stone_bricks'].map(item=>[item,'0.01'])))

export function inventoryShopEvent(event){
  if(event?.action!=='inventory_shop')return null
  if(!UUID.test(event.operationId||'')||!UUID.test(event.playerId||'')||!UUID.test(event.connectionId||'')||
    !Array.isArray(event.args)||event.args.length!==2||!['catalog','quote','checkout','enroll','fund','confirm','status'].includes(event.args[0])||
    typeof event.args[1]!=='string'||event.args[1].length>2048)fail('INVENTORY_SHOP_EVENT_REQUIRED')
  let fields
  try{fields=JSON.parse(event.args[1])}catch{fail('INVENTORY_SHOP_EVENT_FIELDS_REQUIRED')}
  const allowed={catalog:[],quote:['item','count'],checkout:['quoteId'],enroll:['orderId'],fund:['orderId','consentNonce'],confirm:['orderId','consentNonce'],status:['orderId']}[event.args[0]]
  if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(key=>!allowed.includes(key)))fail('INVENTORY_SHOP_EVENT_FIELDS_REQUIRED')
  return{action:event.args[0],input:{...fields,playerId:event.playerId.toLowerCase(),connectionId:event.connectionId.toLowerCase(),...(['confirm','fund'].includes(event.args[0])?{confirmationId:event.operationId.toLowerCase()}:{})}}
}

/** Identity runtime owns the pool. This factory starts no worker until start(). */
export async function openInventoryShopRuntime({rootDirectory,identityRuntime}={}){
  const root=resolve(rootDirectory),active=await json(join(root,'.local/playable-world/active.json'))
  if(active.owner!=='agentcity-playable-pilot'||!/^agentcity-playable-[a-f0-9]{8}$/.test(active.container)||
    resolve(active.runtime)!==join(root,'.local/playable-world',active.container)||
    !identityRuntime?.pool||!identityRuntime?.service||identityRuntime.settings?.serverId!==active.serverId)fail('INVENTORY_SHOP_OWNED_RUNTIME_REQUIRED')
  const settings=await json(join(root,'.local/bank/operator-settings.json')),roster=await json(join(root,'.local/playable-world/bank-actors.json'))
  const actor=settings.actors?.seller,registered=roster.actors?.seller
  if(settings.schema!=='agentcity.bank-operator.v1'||settings.chainId!==1301||settings.operatorControlled!==true||actor?.operatorControlled!==true||
    actor.minecraftUsername!=='BankSeller'||roster.schema!=='agentcity.laptop-bank-actors.v1'||roster.fixture!==true||roster.serverId!==active.serverId||
    registered?.name!=='BankSeller'||!UUID.test(actor.principalId||'')||actor.principalId!==registered.principalId||
    !UUID.test(actor.minecraftPlayerId||'')||actor.minecraftPlayerId!==registered.minecraftPlayerId)fail('INVENTORY_SHOP_CONTROLLED_MERCHANT_REQUIRED')
  const token=(await readFile(join(active.runtime,'api-token'),'utf8')).trim()
  if(token.length<32)fail('INVENTORY_SHOP_NATIVE_TOKEN_REQUIRED')
  const native=async(path,body)=>{
    const response=await fetch('http://127.0.0.1:25597/playable/'+path,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+token,...body===undefined?{}:{'Content-Type':'application/json'}},
      ...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(15000)})
    const value=await response.json()
    if(!response.ok)fail('INVENTORY_SHOP_NATIVE_REQUEST_UNAVAILABLE')
    return value
  }
  const merchant={principalId:actor.principalId,minecraftPlayerId:actor.minecraftPlayerId,sourceId:actor.minecraftPlayerId,
    sourceKind:'player_inventory',walletAddress:actor.wallet.address,operatorSuppliedDemo:true}
  let operator,opening,stopped=false,loop,release
  const getOperatorRuntime=()=>operator||(opening||=createBankLaptopRuntime({rootDirectory:root,manifestFile:'.local/marketplace/public-deployment.json'})
    .then(value=>operator=value).catch(error=>{opening=null;throw error}))
  const {settings:walletSettings,credentials}=await loadPrivySettings(root,{requireProvider:false})
  const verifyPrivyToken=await createPrivyTokenVerifier({appId:walletSettings.appId,appSecret:credentials.appSecret})
  const gameSession=({playerId})=>native('session?playerId='+encodeURIComponent(playerId))
  const readStock=async()=>{
    const current=await gameSession({playerId:merchant.minecraftPlayerId})
    if(current.online!==true||current.pendingAuthentication!==false||current.principalId!==merchant.principalId||
      current.playerName!=='BankSeller'||!UUID.test(current.connectionId||''))fail('INVENTORY_SHOP_MERCHANT_OFFLINE_OR_UNAPPROVED')
    return native('escrow/shop-stock',{sellerId:merchant.principalId,sellerAccountId:merchant.minecraftPlayerId,
      ownerPlayerId:merchant.minecraftPlayerId,sourceId:merchant.sourceId,connectionId:current.connectionId})
  }
  const common={pool:identityRuntime.pool,identity:identityRuntime.service,serverId:active.serverId,gameSession}
  const checkout=await createInventoryShopCheckout({...common,verifyPrivyToken,native,getOperatorRuntime,merchant})
  let flags
  try{flags=await json(join(root,'.local/mumbai-city/shop-settings.json'))}catch(error){if(error.code!=='ENOENT')throw error}
  const inGame=flags?.privyInGameEnabled===true
  let managedWallets,managedOpening
  const getManagedWallets=()=>managedWallets||(managedOpening||=(async()=>{
    if(!inGame)fail('INVENTORY_SHOP_PRIVY_GAME_NOT_ENABLED')
    const loaded=await loadPrivySettings(root),runtime=await getOperatorRuntime(),manifest=runtime.manifest.worldAssets
    const targets=[manifest.city,manifest.market,manifest.registry].map(value=>value.toLowerCase())
    if(loaded.settings.allowBroadcast!==true||loaded.settings.allowedTargets.length!==3||loaded.settings.allowedTargets.some(value=>!targets.includes(value.toLowerCase())))fail('INVENTORY_SHOP_PRIVY_BUYER_POLICY_REQUIRED')
    await loaded.provider.validateConfiguration()
    return managedWallets=await createTestnetWallets({pool:identityRuntime.pool,rootDirectory:root,provider:loaded.provider,
      environment:'UNICHAIN_SEPOLIA_PLAYABLE',chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,
      allowedTargets:loaded.settings.allowedTargets,allowBroadcast:true,maxNativeBudgetWei:loaded.settings.maxNativeBudgetWei})
  })().catch(error=>{managedOpening=null;throw error}))
  let agentShop
  const game=inGame?await createInventoryShopGame({...common,native,getOperatorRuntime,getManagedWallets,merchant,authorizeDelegation:context=>agentShop.authorize(context)}):null
  const shop=await createInventoryShop({...common,readStock,prices:inventoryShopPrices,checkoutMode:inGame?'privy_game':'browser',prepareCheckout:game?game.open:checkout.prepareCheckout})
  if(game)agentShop=await createAgentShop({root,active,pool:identityRuntime.pool,identity:identityRuntime.service,native,game,shop,getOperatorRuntime})
  const authenticateAgent=supplied=>{const value=Buffer.from(String(supplied||'')),expected=Buffer.from('Bearer '+token);return value.length===expected.length&&timingSafeEqual(value,expected)}
  const processEvent=async event=>{
    let result
    try{
      const parsed=inventoryShopEvent(event)
      if(!parsed)return
      const current=await gameSession({playerId:parsed.input.playerId})
      if(current.online!==true||current.pendingAuthentication!==false||current.connectionId?.toLowerCase()!==parsed.input.connectionId||
        current.playerName!==event.playerName)fail('INVENTORY_SHOP_CURRENT_CONNECTION_REQUIRED')
      if(['enroll','fund','confirm','status'].includes(parsed.action)){
        if(!game)fail('INVENTORY_SHOP_PRIVY_GAME_NOT_ENABLED')
        result=await game[parsed.action](parsed.input)
      }else{
        result=await shop[parsed.action](parsed.input)
        if(game&&parsed.action==='catalog')result={...result,activeOrder:await game.latest(parsed.input)}
      }
    }catch(error){
      const code=/^[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'INVENTORY_SHOP_REQUEST_UNAVAILABLE'
      result={error:code,message:/CONNECTION|OWNER/.test(code)?'Approve your current connection in Discord, then reopen /market.'
        :/STOCK|MERCHANT/.test(code)?'The merchant stock is unavailable or changed. Keep any existing order and check its status.'
          :'This step could not finish. Keep this order and check its status before trying another purchase.'}
    }
    await native('inventory-shop/reply',{operationId:event.operationId,result})
  }
  async function start(){
    if(loop)return{started:true}
    let enabled
    try{enabled=(await json(join(root,'.local/mumbai-city/shop-settings.json'))).enabled===true}catch(error){if(error.code!=='ENOENT')throw error}
    if(!enabled)return{started:false,reason:'INVENTORY_SHOP_HOST_NOT_ENABLED'}
    release=await checkpoints.acquireLocalLease('agentcity-inventory-shop:'+active.serverId)
    stopped=false
    loop=(async()=>{
      let warned=false
      while(!stopped){
        try{
          const {events}=await native('events');warned=false
          for(const event of events||[]){if(stopped)break;if(event.action==='inventory_shop')await processEvent(event)}
        }catch{if(!warned)console.warn('UniRock shop reply pending; its original native event remains queued.');warned=true}
        if(!stopped)await new Promise(resolve=>setTimeout(resolve,500))
      }
    })()
    return{started:true}
  }
  return{shop,checkout,game,agentShop,authenticateAgent,native,start,readStock,async close(){stopped=true;await loop;await release?.();await opening?.catch(()=>{});await managedOpening?.catch(()=>{});await operator?.close();}}
}
