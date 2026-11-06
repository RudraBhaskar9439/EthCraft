import {readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import checkpoints from '../bot/checkpoint-store.cjs'
import {loadPrivySettings,createTestnetWallets} from './testnet-wallets.mjs'
import {createPrivyTokenVerifier} from './wallet-auth.mjs'
import {createBankLaptopRuntime} from '../bank/laptop-runtime.mjs'
import {createPoolObservationKeeper} from '../bank/pool-observation-keeper.mjs'
import {createInventoryShop} from './inventory-shop.mjs'
import {createInventoryShopCheckout} from './inventory-shop-checkout.mjs'
import {createInventoryShopGame} from './inventory-shop-game.mjs'
import {createAgentShop} from './agent-shop.mjs'
import {openInvestmentRuntime} from '../investments/runtime.mjs'
import {parseUnits} from 'viem'
import {timingSafeEqual} from 'node:crypto'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail=code=>{throw Object.assign(Error(code),{code})}
const investmentFields={invest_portfolio:['tokenId'],invest_preview:['action','tokenId','city','usdc','tickLower','tickUpper','withdrawBps','tokenIn','tokenOut','amountOut','maximumInput'],invest_confirm:['operationId','consentNonce'],invest_status:['operationId'],invest_routes:['tokenIn','tokenOut','amountOut']}
const json=async file=>JSON.parse(await readFile(file,'utf8'))
export const inventoryShopPrices=Object.freeze(Object.fromEntries(['oak_planks','cobblestone','stone','dirt','sand','oak_log','stick','stone_bricks'].map(item=>[item,'0.01'])))

export function inventoryShopEvent(event){
  if(event?.action!=='inventory_shop')return null
  if(!UUID.test(event.operationId||'')||!UUID.test(event.playerId||'')||!UUID.test(event.connectionId||'')||
    !Array.isArray(event.args)||event.args.length!==2||!['catalog','quote','checkout','enroll','fund','confirm','status',...Object.keys(investmentFields)].includes(event.args[0])||
    typeof event.args[1]!=='string'||event.args[1].length>2048)fail('INVENTORY_SHOP_EVENT_REQUIRED')
  let fields
  try{fields=JSON.parse(event.args[1])}catch{fail('INVENTORY_SHOP_EVENT_FIELDS_REQUIRED')}
  const allowed={catalog:[],quote:['item','count'],checkout:['quoteId'],enroll:['orderId'],fund:['orderId','consentNonce'],confirm:['orderId','consentNonce'],status:['orderId'],...investmentFields}[event.args[0]]
  if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(key=>!allowed.includes(key)))fail('INVENTORY_SHOP_EVENT_FIELDS_REQUIRED')
  return{action:event.args[0],input:{...fields,playerId:event.playerId.toLowerCase(),connectionId:event.connectionId.toLowerCase(),...(['confirm','fund','invest_confirm'].includes(event.args[0])?{confirmationId:event.operationId.toLowerCase()}:{})}}
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
  const observationKeeper=createPoolObservationKeeper({
    acquireLease:()=>checkpoints.acquireLocalLease('ethcraft-investment-observations'),
    record:state=>checkpoints.writeCheckpoint(join(root,'.local/investments/observation-keeper.json'),{owner:'ethcraft-pool-observer',pid:process.pid,serverId:active.serverId,...state}),
    publish:async()=>{
      const config=await json(join(root,'.local/investments/privy.json'))
      if(config.enabled!==true||config.chainId!==1301||!Number.isSafeInteger(config.expiresAt)||Date.now()>=config.expiresAt*1000)fail('INVEST_DELEGATION_EXPIRED')
      const runtime=await getOperatorRuntime()
      if(runtime.manifest.mode!=='marketplace'||runtime.manifest.chainId!==1301||runtime.manifest.deploymentId!==config.deploymentId)fail('INVEST_OBSERVATION_BINDING_CHANGED')
      return runtime.publishReference()
    }
  })
  const {settings:walletSettings,credentials}=await loadPrivySettings(root,{requireProvider:false})
  const verifyPrivyToken=await createPrivyTokenVerifier({appId:walletSettings.appId,appSecret:credentials.appSecret})
  const gameSession=({playerId})=>native('session?playerId='+encodeURIComponent(playerId))
  let investment,investmentOpening
  const investments=()=>investment||(investmentOpening||=openInvestmentRuntime({root,pool:identityRuntime.pool,identity:identityRuntime.service,serverId:active.serverId,gameSession})
    .then(value=>investment=value).catch(error=>{investmentOpening=null;throw error}))
  async function investmentAction(action,input){
    const api=await investments()
    if(action==='invest_preview'&&['deposit','increase'].includes(input.action)){
      for(const key of ['city','usdc'])if(typeof input[key]!=='string'||!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input[key])||input[key].split('.')[1]?.length>(key==='city'?18:6))fail('INVEST_DECIMAL_AMOUNT_REQUIRED')
      const city=String(parseUnits(input.city,18)),usdc=String(parseUnits(input.usdc,6)),key=api.manifest.pools.cityUsdc
      input={...input,amount0:key.currency0.toLowerCase()===api.manifest.city.toLowerCase()?city:usdc,amount1:key.currency1.toLowerCase()===api.manifest.usdc.toLowerCase()?usdc:city}
      if(input.action==='deposit'&&input.tickLower===undefined&&input.tickUpper===undefined){
        const state=await api.portfolio(input),center=Math.floor(state.tick/60)*60
        input={...input,tickLower:center-600,tickUpper:center+600}
      }
    }
    return api[{invest_portfolio:'portfolio',invest_preview:'preview',invest_confirm:'confirm',invest_status:'status',invest_routes:'routes'}[action]](input)
  }
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
      if(parsed.action.startsWith('invest_'))result=await investmentAction(parsed.action,parsed.input)
      else if(['enroll','fund','confirm','status'].includes(parsed.action)){
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
    if(inGame)observationKeeper.start()
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
  return{shop,checkout,game,agentShop,authenticateAgent,native,start,readStock,investments,observationKeeper,async close(){stopped=true;await loop;await observationKeeper.stop();await release?.();await opening?.catch(()=>{});await managedOpening?.catch(()=>{});await operator?.close();}}
}
