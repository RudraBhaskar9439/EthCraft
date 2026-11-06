import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createDiscordServerLayout} from './server-layout.mjs'
import {createAgentPresence} from './agent-presence.mjs'
import {createActivityFeed} from './activity-feed.mjs'

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rootDefault=fileURLToPath(new URL('../../../',import.meta.url))
const safe=value=>String(value||'').replaceAll('@','＠').slice(0,500)
const button=(id,label,style=2)=>({type:2,custom_id:id,label,style})
const row=components=>({type:1,components})
const embed=(title,description)=>({title,description,color:0x37a77a})

// Reporting only. No signer, funding, wallet provisioning or gameplay adapter.
export function publicReceiptVerifier(root=rootDefault){
 let client
 return async candidate=>{
  if(candidate.chainId!==1301)return null
  if(!client){
   const manifest=JSON.parse(await readFile(join(root,'.local/playable-testnet/market.json'),'utf8'))
   if(manifest.chainId!==1301||manifest.environment!=='UNICHAIN_SEPOLIA_PLAYABLE')return null
   const url=new URL(manifest.rpcUrl)
   if(url.protocol!=='https:'||url.username||url.password)return null
   const {createPublicClient,http}=await import('viem');client=createPublicClient({transport:http(url.href,{timeout:10000,retryCount:0})})
  }
  if(await client.getChainId()!==1301)return null
  const receipt=await client.getTransactionReceipt({hash:candidate.transactionHash})
  const [block,head]=await Promise.all([client.getBlock({blockNumber:receipt.blockNumber}),client.getBlockNumber()])
  if(receipt.blockHash!==block.hash||receipt.blockHash.toLowerCase()!==candidate.receipt.blockHash.toLowerCase())return null
  const confirmations=head-receipt.blockNumber+1n
  if(confirmations<2n)return null
  return{verified:true,chainId:1301,transactionHash:receipt.transactionHash,blockHash:receipt.blockHash,blockNumber:String(receipt.blockNumber),status:receipt.status==='success'?'confirmed':'reverted',confirmations:Number(confirmations)}
 }
}

export async function createServerExperience({settings,pool,client,agents,identity,executeOwner,createWork,agentPanel,verifyPublicReceipt=publicReceiptVerifier(),worldAssets}={}){
 const guild=await client.guilds.fetch(settings.guildId),layout=createDiscordServerLayout({pool,guild,coordinatorBotId:settings.applicationId,serverId:settings.serverId})
 await layout.initialize()
 await pool.query(`CREATE TABLE IF NOT EXISTS ac_discord_server_posts(
  guild_id text NOT NULL,purpose text NOT NULL,channel_id text NOT NULL,message_id text,body_hash text,state text NOT NULL DEFAULT 'new',
  PRIMARY KEY(guild_id,purpose))`)
 const ownerForId=async ownerId=>{const row=(await pool.query('SELECT discord_user_id FROM ac_discord_identities WHERE principal_id=$1',[ownerId])).rows[0];return row?identity.getOwner(row.discord_user_id):null}
 let rooms,feed,timer,refreshing=false,closed=false,lastShape,error=null,presenceError=null
 const roomFor=async slot=>layout.getRoom(slot.name)
 const presence=createAgentPresence({settings,agents,identity,executeOwner,createWork,resolveOwner:ownerForId,
  roomDelivery:async({slot,owner,payload,client:agentClient})=>{
   const room=await roomFor(slot)
   if(!room||!room.memberIds.includes(owner.discordUserId)||!room.memberIds.includes(agentClient.user.id))return false
   await layout.assertPrivateRoom({channelId:room.channelId,memberIds:room.memberIds})
   const channel=await agentClient.channels.fetch(room.channelId);return channel.send({...payload,allowedMentions:{parse:[]}})
  }})
 async function managedPost(purpose,channelId,payload,privateRoom){
  const marker='AgentCity · '+purpose,body={...payload,embeds:(payload.embeds||[]).map((value,index)=>({...value.toJSON?.()||value,...(index===0?{footer:{text:marker}}:{})})),allowedMentions:{parse:[]}}
  if(!body.embeds.length)body.embeds=[{description:'AgentCity',footer:{text:marker}}]
  const hash=digest(body)
  const saved=(await pool.query('SELECT * FROM ac_discord_server_posts WHERE guild_id=$1 AND purpose=$2',[guild.id,purpose])).rows[0]
  if(saved&&saved.channel_id!==channelId)throw Error('DISCORD_MANAGED_POST_CHANNEL_CONFLICT')
  const channel=privateRoom?await layout.assertPrivateRoom({channelId,memberIds:privateRoom.memberIds}):await client.channels.fetch(channelId)
  if(saved?.message_id&&saved.body_hash===hash&&saved.state==='ready')return
  let message=saved?.message_id?await channel.messages.fetch(saved.message_id):null
  if(message&&message.author.id!==settings.applicationId)throw Error('DISCORD_MANAGED_POST_AUTHOR_CONFLICT')
  if(!message){
   const recent=await channel.messages.fetch({limit:100})
   message=[...recent.values()].find(item=>item.author.id===settings.applicationId&&item.embeds.some(value=>value.footer?.text===marker))
   if(!message&&saved?.state==='sending')throw Error('DISCORD_MANAGED_POST_RECONCILIATION_REQUIRED')
  }
  if(message)await message.edit(body)
  else{
   await pool.query(`INSERT INTO ac_discord_server_posts(guild_id,purpose,channel_id,state) VALUES($1,$2,$3,'sending')
    ON CONFLICT(guild_id,purpose) DO UPDATE SET state='sending'`,[guild.id,purpose,channelId])
   message=await channel.send({...body,nonce:BigInt('0x'+digest([guild.id,purpose]).slice(0,15)).toString(),enforceNonce:true})
  }
  await pool.query(`INSERT INTO ac_discord_server_posts(guild_id,purpose,channel_id,message_id,body_hash,state) VALUES($1,$2,$3,$4,$5,'ready')
   ON CONFLICT(guild_id,purpose) DO UPDATE SET message_id=$4,body_hash=$5,state='ready'`,[guild.id,purpose,channelId,message.id,hash])
 }
 async function reconcile(){
  const directory=presence.directory(),mapped=[]
  for(const slot of agents.status()){
   const owner=await ownerForId(slot.ownerId);if(!owner)continue
   const entry=directory.find(value=>value.name===slot.name)
   const room=await roomFor(slot)
   if(room&&entry?.ready&&!room.memberIds.includes(entry.applicationId))await layout.addAgentBot({slotName:slot.name,ownerDiscordId:owner.discordUserId,agentBotId:entry.applicationId})
   mapped.push({slotName:slot.name,ownerDiscordId:owner.discordUserId,...(entry?.ready?{agentBotId:entry.applicationId}:{})})
  }
  const shape=digest(mapped)
  if(shape!==lastShape){rooms=await layout.reconcile({agents:mapped});if(!rooms.ok)throw Error('DISCORD_LAYOUT_PERMISSIONS_REQUIRED');lastShape=shape}
  return directory
 }
 async function refresh(){
  if(refreshing||closed)return
  refreshing=true
  try{
   const directory=await reconcile()
   await managedPost('welcome',rooms.welcomeId,{embeds:[embed('Welcome to AgentCity','Play together. Let your agent keep working while you are away.\n\n**1 · Connect** — use /start, then /profile.\n**2 · Meet your agent** — open /agents.\n**3 · Play** — connect to the Minecraft address provided by the host, then approve your connection with /join.\n\nAsk for work in the jobs area. Keep wallet setup in Discord and the secure browser.')],components:[row([button('ac:setup:self','Connect my account',1),button('ac:directory:self','My agent')])]})
   const fields=directory.filter(value=>value.ownerId).map(value=>({name:safe(value.name),value:`${value.ready?value.mention:'Bot profile awaiting provisioning'}\n${value.connected?'In the world':'Offline in Minecraft'} · ${value.ready?'DM this bot or use /agents':'Use /agents for your private room'}`,inline:true}))
   await managedPost('directory',rooms.agentDirectoryId,{embeds:[{...embed('Your city, your agents','DM an agent bot to talk to it. Your own agent accepts instructions; another player’s agent accepts work requests.\n\nPrivate plans and screenshots stay in your agent room or DM.'),...(fields.length?{fields:fields.slice(0,25)}:{})}],components:[row([button('ac:directory:self','Open my agent room',1)])]})
   await managedPost('jobs-guide',rooms.jobsId,{embeds:[embed('Jobs board','Use /work to request a registered agent or player, /offer to quote, and /worklist to review. Job cards show progress; each job’s conversation has its own private room.\n\nAccepted terms await funding. A card does not mean work was paid or authorized.') ]})
   await managedPost('marketplace-guide',rooms.marketplaceId,{embeds:[embed('World asset marketplace','**CITY · Unichain Sepolia**\nAll new item and property sales settle on chain. Use /assets to register plain resource lots or equipment, claim estate land, update a house snapshot, list or buy assets, redeem items, and swap CITY/GEM through Uniswap. Review and explicitly confirm each transaction. Land and its house transfer together.\n\nOlder escrowed items remain available to their original owner through /bazaar cancel and claim; they are not automatically converted into new assets.\n\nItem custody is backed before registration. Estate access follows confirmed chain ownership; item collection requires an approved game connection.')],components:[row([button('ac:asset-browse:self','Browse CITY assets',1)])]})
   await managedPost('transactions-guide',rooms.transactionsId,{embeds:[embed('Transaction activity','**World assets · Unichain Sepolia** — verified registration, listing, purchase and redemption events with explorer links. On-chain confirmation and game application are separate statuses.\n**Uniswap** — verified CITY/GEM swap receipts.\n\nThis feed reports recorded activity and never creates payments.')]})
   for(const slot of agents.status()){
    const owner=await ownerForId(slot.ownerId);if(!owner)continue
    const room=await roomFor(slot);if(!room)continue
    const controls=agentPanel(slot,slot.ownerId)
    await managedPost('agent:'+slot.name,room.channelId,{...controls,content:`Your private room for **${safe(slot.name)}**. Use the controls below or /agent to give an instruction. Server administrators can also access this room.`},room)
   }
   await feed?.sync();error=null
  }catch(cause){error=/^[A-Z_]+$/.test(cause.code||cause.message||'')?cause.code||cause.message:'DISCORD_SERVER_REFRESH_UNAVAILABLE';throw cause}
  finally{refreshing=false}
 }
 async function ensureJob(job){
  const owners=await Promise.all([ownerForId(job.requesterOwnerId),ownerForId(job.targetOwnerId)])
  if(owners.some(owner=>!owner))throw Error('DISCORD_JOB_PARTICIPANTS_REQUIRED')
  const room=await layout.privateJobRoom({jobId:job.workId||job.id,participantDiscordIds:owners.map(owner=>owner.discordUserId)})
  if(!room.ok)throw Error('DISCORD_JOB_ROOM_UNAVAILABLE')
  const members=[...new Set([...owners.map(owner=>owner.discordUserId),settings.applicationId])].sort()
  await managedPost('job:'+(job.workId||job.id),room.channelId,{embeds:[embed('Work request',`${safe(job.request)}\n\nState: **${safe(job.state).replaceAll('_',' ')}**\n${job.quote?`Quote: ${safe(job.quote.price)} ${safe(job.quote.asset)}\n${safe(job.quote.scope)}`:'Use /offer to propose exact terms.'}\n\nUse /worklist to review and accept the current quote.`)]},{memberIds:members})
  return room
 }
 return{
  async start(){await refresh();feed=await createActivityFeed({pool,agents:()=>agents.status(),serverId:settings.serverId,verifyPublicReceipt,worldAssetViews:worldAssets?async()=>({...await worldAssets.service.browse(),receipts:await worldAssets.service.receipts()}):undefined,channelProvider:async name=>{
    const channel=await client.channels.fetch(name==='jobs'?rooms.jobsId:name==='marketplace'?rooms.marketplaceId:rooms.transactionsId)
    return{id:channel.id,send:payload=>channel.send(payload),edit:(id,payload)=>channel.messages.edit(id,payload),findByNonce:async(nonce,marker)=>{const recent=await channel.messages.fetch({limit:100});return[...recent.values()].find(message=>message.author.id===settings.applicationId&&(message.nonce===nonce||message.embeds.some(value=>value.footer?.text===marker)))}}
   }});void presence.start().then(()=>refresh()).catch(()=>{presenceError='AGENT_BOT_PROVISIONING_UNAVAILABLE'});void feed.sync().catch(()=>{error='DISCORD_ACTIVITY_UNAVAILABLE'});timer=setInterval(()=>{refresh().catch(()=>{})},30000);timer.unref();return rooms},
  refresh,ensureJob,
  async panel(owner){await refresh();const slot=agents.status().find(value=>value.ownerId===owner.ownerId);if(!slot)return null;const room=await roomFor(slot);if(!room||!room.memberIds.includes(owner.discordUserId))return null;await layout.assertPrivateRoom({channelId:room.channelId,memberIds:room.memberIds});const entry=presence.directory().find(value=>value.name===slot.name);return{content:`Your agent room: <#${room.channelId}>.${entry?.ready?` You can also DM ${entry.mention}.`:''}`,allowedMentions:{parse:[]}}},
  async deliver(ownerId,payload){const direct=await presence.deliver({ownerId,message:payload.content,files:payload.files||[]});if(direct.delivered)return{id:direct.messageId,channelId:direct.channelId};const owner=await ownerForId(ownerId),slot=agents.status().find(value=>value.ownerId===ownerId);if(!owner||!slot)return null;const room=await roomFor(slot);if(!room||!room.memberIds.includes(owner.discordUserId))return null;return layout.sendPrivate({channelId:room.channelId,memberIds:room.memberIds,payload})},
  get channels(){return rooms},status(){return{error,presenceError,presence:presence.status(),channels:rooms}},
  async close(){closed=true;clearInterval(timer);await presence.close();await feed?.close()}
 }
}
