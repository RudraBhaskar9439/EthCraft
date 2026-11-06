import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import pg from '../backend/node_modules/pg/lib/index.js'
import { createAgentManager, validatePersonalAgentCapacity, PERSONAL_AGENT_NAMES } from '../backend/src/playable/agents.mjs'
import { loadAgentModelProvider } from '../backend/src/inference/anthropic.mjs'
import { loadZeroGProvider } from '../backend/src/inference/zero-g.mjs'
import { readDiscordConfiguration } from '../backend/src/discord/settings.mjs'
import { openDiscordIdentityRuntime } from '../backend/src/discord/runtime.mjs'
import { createDiscordBridge } from '../backend/src/discord/bot.mjs'
import { captureWorldScreenshot } from '../backend/src/playable/world-screenshot.mjs'
import { createMarketplaceRuntime } from '../backend/src/discord/marketplace-runtime.mjs'
import { createWorldAssetDiscordRuntime } from '../backend/src/discord/world-assets-runtime.mjs'
import { createOnchainGameRuntime, createOnchainAgentMarketRuntime } from '../backend/src/discord/onchain-game.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const data = JSON.parse(await readFile(join(root, '.local/playable-world/active.json'), 'utf8'))
if (!/^agentcity-playable-[a-f0-9]{8}$/.test(data.container) || data.owner !== 'agentcity-playable-pilot') throw Error('owned_world_required')
const runtime = join(root, '.local/playable-world', data.container)
const token = (await readFile(join(runtime, 'api-token'), 'utf8')).trim()
const settings = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 4 })
const api = async (path, body) => {
  const response = await fetch('http://127.0.0.1:25597/playable/' + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
  if (!response.ok) {
    if(path.startsWith('escrow/')||path.startsWith('property/')){
      const result=await response.json().catch(()=>({})),code=result.reason||result.error
      if(typeof code==='string'&&/^(?:escrow_[a-z_]+|ESCROW_[A-Z_]+|property_[a-z_]+|PROPERTY_[A-Z_]+|estate_[a-z_]+)$/.test(code))throw Object.assign(Error(code),{code})
    }
    throw Error('plugin_http_' + response.status)
  }
  return response.json()
}
const world = await api('status')
validatePersonalAgentCapacity(world)
let discordIdentityRuntime, discordBridge, worldAssets, worldAssetTimer, onchainGame, onchainAgentMarket
const discordSettings=await readDiscordConfiguration(root,{credentials:false})
if(discordSettings)discordIdentityRuntime=await openDiscordIdentityRuntime({rootDirectory:root,pool,pluginApi:api,agentsProvider:()=>agents})
async function taskResult(playerId,message){
  await api('notify',{playerId,message:String(message).slice(0,3000)})
  if(discordBridge)await discordBridge.notifyOwner(playerId,message)
}
let agentSettings={}
try{agentSettings=JSON.parse(await readFile(join(runtime,'agent-settings.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
if(agentSettings.model!==undefined&&!/^[A-Za-z0-9_.:-]{1,80}$/.test(agentSettings.model))throw Error('LOCAL_AGENT_MODEL_REQUIRED')
const loadProvider = settings => settings.provider === '0g' ? loadZeroGProvider(root, settings) : loadAgentModelProvider(root, settings)
const modelProvider = await loadProvider(agentSettings)
const slotSettings = agentSettings.slotProviders ?? {}
if (!slotSettings || typeof slotSettings !== 'object' || Array.isArray(slotSettings) ||
    Object.entries(slotSettings).some(([name, settings]) => !PERSONAL_AGENT_NAMES.includes(name) || !settings || typeof settings !== 'object' || Array.isArray(settings))) throw Error('INVALID_SLOT_MODEL_SETTINGS')
const slotModelProviders = {}
for (const [name, settings] of Object.entries(slotSettings)) {
  slotModelProviders[name] = await loadProvider(settings)
  console.log('Personal-agent slot model provider:', name, slotModelProviders[name].kind, slotModelProviders[name].model)
}
console.log('Personal-agent model provider:', modelProvider.kind, modelProvider.model)
const agents = await createAgentManager({ rootDirectory: root, runtimeDirectory: runtime, gamePort: 25596,
  modelProvider, slotModelProviders,
  movementBounds: world.taskBounds, taskRegions: world.taskRegions, playWorld: world.playWorld, playSpawn: world.playSpawn,
  onTaskResult: taskResult,
  authorizeRemote:discordIdentityRuntime?(request=>discordIdentityRuntime.authorizeRemote(request)):undefined,
  screenshotHandler:async({bot,ownerId,slotName,operationId})=>{
    const region=world.taskRegions.find(value=>value.slotName===slotName)
    if(!region)throw Error('OWNED_SCREENSHOT_REGION_REQUIRED')
    const structure=agents.tools.state.tasks.filter(task=>task.ownerId===ownerId&&task.plan.placements?.length).at(-1)
    const cells=structure?.plan.placements
    const target=cells?.length?{x:cells.reduce((sum,p)=>sum+p.position[0],0)/cells.length+.5,y:cells.reduce((sum,p)=>sum+p.position[1],0)/cells.length+.5,z:cells.reduce((sum,p)=>sum+p.position[2],0)/cells.length+.5}:undefined
    const image=await captureWorldScreenshot(bot,{bounds:{min:{...region.min,y:region.min.y-1},max:region.max},target,worldName:world.playWorld,outputDirectory:join(root,'.local/discord/screenshots')})
    if(discordBridge)await discordBridge.notifyOwner(ownerId,`Actual agent world view observed ${image.metadata.observedAt}. The image uses observed blocks and nearby-version Minecraft assets.`,image)
    return{complete:true,message:discordBridge?'Captured your actual world view and queued the image privately in Discord.':'Captured your actual world view. Discord delivery is waiting for the bot configuration.'}
  },
  onTaskLock:async(slot,task,state)=>{
    const remote=slot.remoteContext
    if(remote&&state.locked){
      if(!discordIdentityRuntime)throw Error('DISCORD_REMOTE_AUTHORITY_REQUIRED')
      await discordIdentityRuntime.authorizeRemote({operationId:task.operationId||task.id,ownerId:slot.ownerId,ownerName:slot.ownerName,
        agentId:slot.name,tool:task.plan?.action||'inspect',grant:slot.remoteProof?.grant,session:slot.remoteProof?.session,phase:'lock'})
    }
    return api('task-lock',{slotName:slot.name,taskId:task.id,ownerId:slot.ownerId,ownerPlayerId:slot.minecraftPlayerId||slot.ownerId,locked:state.locked,
      ...(remote?{remoteGrantId:remote.grantId,tool:task.plan?.action||'inspect'}:{})})
  },
  saleHandler: async()=>({complete:false,message:'Item sales use CITY on Unichain Sepolia. Use /assets action:register_item source:agent in Discord, then list and explicitly confirm your price.'}),
  marketContext: async()=>({marketAvailable:Boolean(worldAssets),supportedAssets:worldAssets?['CITY','GEM']:[],prices:{}}),
  marketHandler:async(event,step)=>{
    if(!onchainAgentMarket)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
    return onchainAgentMarket.handle(event,step)
  } })
const bazaar=discordIdentityRuntime?await createMarketplaceRuntime({pool,identity:discordIdentityRuntime.service,settings:discordSettings,agents,pluginApi:api}):null
if(discordIdentityRuntime){
  try{
    worldAssets=await createWorldAssetDiscordRuntime({rootDirectory:root,pool,identity:discordIdentityRuntime.service,agents,native:api})
    worldAssetTimer=setInterval(()=>void worldAssets.sync().catch(error=>console.error('World ownership sync waiting:',/^[A-Z0-9_]+$/.test(error.message)?error.message:'WORLD_ASSET_SYNC_UNAVAILABLE')),10000)
    worldAssetTimer.unref()
    await worldAssets.sync()
    onchainGame=createOnchainGameRuntime({identity:discordIdentityRuntime.service,serverId:discordSettings.serverId,native:api,worldAssets,recovery:bazaar})
    onchainAgentMarket=createOnchainAgentMarketRuntime({worldAssets,agents,resolveDiscordUser:async principalId=>(await pool.query('SELECT discord_user_id FROM ac_discord_identities WHERE principal_id=$1',[principalId])).rows[0]?.discord_user_id})
  }catch(error){console.error('World assets setup waiting:',error.code==='ENOENT'?'WORLD_ASSET_DEPLOYMENT_NOT_CONFIGURED':/^[A-Z0-9_]+$/.test(error.message)?error.message:'WORLD_ASSET_CONFIGURATION_REQUIRED')}
}
if(discordSettings?.enabled){
  try{
    const configured=await readDiscordConfiguration(root,{required:true})
    discordBridge=await createDiscordBridge({settings:configured,pool,identity:discordIdentityRuntime.service,agents,marketplace:bazaar,worldAssets,
      screenshotDirectory:join(root,'.local/discord/screenshots'),gameSession:({owner})=>discordIdentityRuntime.pendingForOwner(owner),
      onReady:()=>console.log('Discord AgentCity panel and commands are connected.')})
    await discordBridge.start()
  }catch(error){console.error('Discord setup is waiting:',/^[A-Z_]+$/.test(error.message)?error.message:'Check the private bot configuration and server invite.')}
}
let stopping = false
const inFlight = new Map()
let lastError = null
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true })
console.log('Playable worker ready: on-chain CITY assets, managed wallets and owned agents.')
try {
  while (!stopping) {
    try {
      const { events } = await api('events')
      lastError = null
      for (const event of events) {
        if(inFlight.has(event.operationId)) continue
        const processEvent = async () => {
        let message
        try {
          if (event.action.startsWith('agent_')) {
            let attributed=event
            if(discordIdentityRuntime){
              try{const owner=await discordIdentityRuntime.service.getMinecraftOwner(discordSettings.serverId,event.playerId);attributed={...event,playerId:owner.ownerId,playerName:owner.ownerName,actorPlayerId:event.playerId}}
              catch(error){if(error.code!=='MINECRAFT_ALIAS_NOT_LINKED')throw error}
            }
            message = await agents.handle(attributed)
          } else if(event.action==='estate') {
            if(!worldAssets||!discordIdentityRuntime)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
            const owner=await discordIdentityRuntime.service.getMinecraftOwner(discordSettings.serverId,event.playerId),session=await api('session?playerId='+encodeURIComponent(event.playerId))
            if(!session.online||session.pendingAuthentication!==false||session.connectionId!==event.connectionId||session.principalId!==owner.ownerId)throw Error('WORLD_ASSET_APPROVED_GAME_SESSION_REQUIRED')
            const result=await worldAssets.handleDiscord({userId:owner.discordUserId,operationId:'game-estate:'+event.operationId,action:'owned'})
            message=(result.assets||[]).filter(asset=>asset.kind==='parcel').map(asset=>`Estate ${asset.parcelId}: chain asset ${asset.tokenId}, ${asset.listing?.active?'listed for sale':'owned'}. /estate visit ${asset.parcelId}`).join(' | ')||'No confirmed estate deed is linked to your wallet. Use /assets in Discord to review the parcel catalog and registration.'
          } else if(event.action==='bazaar') {
            if(!onchainGame)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
            message=await onchainGame.handle(event)
          } else if(event.action.startsWith('crypto_')) {
            if(!onchainGame)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
            message=await onchainGame.handle(event)
          } else {
            if(!onchainGame)throw Error('WORLD_ASSET_RUNTIME_SETUP_PENDING')
            message=await onchainGame.handle(event)
          }
        } catch (error) {
          message = error.code?.startsWith('DISCORD_GAME_WALLET_')
            ? 'Wallet view requires your current Discord-approved game connection. Reconnect and approve it with /join in Discord, or use /wallet in Discord.'
            : 'Task stopped: ' + error.message.slice(0, 200)
        }
        await api('ack', { operationId: event.operationId, message: String(message).slice(0, 3000) })
        }
        if(event.action==='agent_task'||event.action==='bazaar'||event.action==='estate'||event.action.startsWith('crypto_')) {
          const work=processEvent().catch(error=>console.error('Agent request waiting:',error.message)).finally(()=>inFlight.delete(event.operationId))
          inFlight.set(event.operationId,work)
        } else await processEvent()
      }
    } catch (error) { if(lastError!==error.message)console.error('Worker waiting:', error.message);lastError=error.message }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
} finally { clearInterval(worldAssetTimer);await agents.close(); await Promise.allSettled(inFlight.values()); await discordBridge?.close(); await worldAssets?.close();await bazaar?.close?.(); await discordIdentityRuntime?.close(); await pool.end() }
