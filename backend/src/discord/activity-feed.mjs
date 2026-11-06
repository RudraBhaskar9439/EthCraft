import {createHash} from 'node:crypto'
import {formatUnits} from 'viem'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^0x[a-f0-9]{64}$/i
const states=new Set(['requested','quoted','terms_accepted_awaiting_funding','declined','cancelled','running','finishing','paused','blocked','reconciliation_required','complete'])
const schema=`CREATE TABLE IF NOT EXISTS ac_discord_activity_projections(
 server_id text NOT NULL,feed text NOT NULL,source_key text NOT NULL,payload jsonb NOT NULL,desired_digest text NOT NULL,
 nonce text NOT NULL,marker text NOT NULL,channel_id text,message_id text,delivered_digest text,
 status text NOT NULL DEFAULT 'pending',updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(server_id,feed,source_key));`
const field=(name,value)=>({name,value:String(value),inline:true})

/** Projection/outbox only. Economic source tables are read, never modified. */
export async function createActivityFeed({pool,channelProvider,agents=()=>[],serverId,verifyPublicReceipt,worldAssetViews,onchainOnly=true}={}){
 if(!pool?.connect||typeof channelProvider!=='function'||typeof serverId!=='string'||!serverId||serverId.length>128)throw Error('ACTIVITY_FEED_CONFIGURATION_REQUIRED')
 await pool.query(schema)
 let closed=false,running=null
 const table=async name=>Boolean((await pool.query('SELECT to_regclass($1) AS name',[name])).rows[0].name)
 const marker=(feed,key)=>'ac-feed:'+digest([serverId,feed,key]).slice(0,24)
 const payload=(feed,key,embed)=>({embeds:[{...embed,footer:{text:'AgentCity · '+marker(feed,key)}}],allowedMentions:{parse:[]}})
 async function jobs(){
  const result=[],slots=typeof agents==='function'?await agents():typeof agents.status==='function'?agents.status():agents
  const safeSlots=Array.isArray(slots)?slots:[]
  if(await table('ac_discord_work_requests'))for(const row of(await pool.query('SELECT id,target_agent,state,created_at FROM ac_discord_work_requests ORDER BY created_at DESC,id LIMIT 10')).rows){
   if(!UUID.test(row.id))continue
   const key='offer:'+row.id,state=states.has(row.state)?row.state:'unknown'
   const agent=safeSlots.some(slot=>slot.name===row.target_agent)?row.target_agent:'Participant'
   result.push({feed:'jobs',key,occurredAt:+new Date(row.created_at),payload:payload('jobs',key,{title:'Work offer · '+digest(row.id).slice(0,8),description:'Public metadata only. Accepted terms still await funding; this card does not authorize execution.',fields:[field('Agent',agent),field('State',state.replaceAll('_',' '))],color:0x5865f2})})
  }
  for(const slot of safeSlots){
   if(!/^[A-Za-z0-9_-]{1,40}$/.test(slot.name||''))continue
   for(const task of(Array.isArray(slot.tasks)?slot.tasks:[]).slice(-10)){
    if(!UUID.test(task.id))continue
    const key='task:'+task.id,state=states.has(task.status)?task.status:'unknown'
    const complete=Number.isSafeInteger(task.completed)&&task.completed>=0?task.completed:0,total=Number.isSafeInteger(task.total)&&task.total>=complete?task.total:complete
    result.push({feed:'jobs',key,occurredAt:Date.now(),payload:payload('jobs',key,{title:'Agent task · '+digest(task.id).slice(0,8),description:'Observed task state; private instructions and participants are omitted.',fields:[field('Agent',slot.name),field('State',state.replaceAll('_',' ')),field('Progress',complete+'/'+total)],color:0x3498db})})
   }
  }
  return result.sort((a,b)=>b.occurredAt-a.occurredAt).slice(0,10)
 }
 async function gameCoins(){
  if(!await table('ac_game_transfers')||!await table('ac_game_ledger'))return[]
  const result=[]
  const rows=(await pool.query(`SELECT t.transfer_id,t.amount,t.confirmed_at,count(l.id)::integer AS legs,
   COALESCE(sum(l.delta_available),0)::text AS net,COALESCE(sum(l.delta_held),0)::text AS held,
   COALESCE(sum(CASE WHEN l.player_id=t.sender_id THEN l.delta_available ELSE 0 END),0)::text AS sender,
   COALESCE(sum(CASE WHEN l.player_id=t.recipient_id THEN l.delta_available ELSE 0 END),0)::text AS recipient,
   bool_and(l.delta_held=0) AS no_holds
   FROM (SELECT * FROM ac_game_transfers WHERE state='confirmed' ORDER BY confirmed_at DESC NULLS LAST,transfer_id LIMIT 10) t
   LEFT JOIN ac_game_ledger l ON l.operation_key='transfer:'||t.transfer_id::text AND l.kind='transfer'
   GROUP BY t.transfer_id,t.amount,t.confirmed_at ORDER BY t.confirmed_at DESC NULLS LAST,t.transfer_id`)).rows
  for(const row of rows){
   const amount=BigInt(row.amount)
   if(amount<=0n||row.legs!==2||BigInt(row.net)!==0n||BigInt(row.held)!==0n||!row.no_holds||BigInt(row.sender)!==-amount||BigInt(row.recipient)!==amount)continue
   const key='game-transfer:'+row.transfer_id
   result.push({feed:'transactions',key,occurredAt:+new Date(row.confirmed_at),payload:payload('transactions',key,{title:'GAME COINS · payment receipt',description:'Internal game currency. Separate from blockchain tokens; no wallet identities are published.',fields:[field('Record',digest(row.transfer_id).slice(0,8)),field('Amount',amount+' Game Coins'),field('State','Confirmed · balanced internal ledger')],color:0xf1c40f})})
  }
  // Starter grants are deliberately omitted: account enrollment is private.
  return result
 }
 async function marketplace(){
  if(!await table('ac_game_market_listings'))return[]
  const rows=(await pool.query(`SELECT listing_id,item,count,price,state,created_at FROM ac_game_market_listings
   WHERE stock_receipt->>'escrowed'='true' AND state IN ('open','reserved','sold','return_pending','cancelled')
   ORDER BY created_at DESC,listing_id LIMIT 10`)).rows
  return rows.map(value=>{
   const key='listing:'+value.listing_id,body=payload('marketplace',key,{title:`${value.count} ${value.item}`,
    description:`**${value.price} Game Coins** for the complete lot.\nListing: \`${value.listing_id}\``,
    fields:[field('State',value.state.replaceAll('_',' ')),field('Stock','Items reserved for this lot')],color:value.state==='open'?0x37a77a:0x7f8c8d})
   if(value.state==='open')body.components=[{type:1,components:[{type:2,custom_id:'ac:market-preview:'+value.listing_id,label:'Preview purchase',style:1}]}]
   return{feed:'marketplace',key,occurredAt:+new Date(value.created_at),payload:body}
  })
 }
 async function marketReceipts(){
  if(!await table('ac_game_market_purchases')||!await table('ac_game_market_ledger'))return[]
  const rows=(await pool.query(`SELECT p.purchase_id,p.item,p.count,p.price,p.updated_at,
   count(l.*)::integer AS legs,count(*) FILTER(WHERE l.kind='reserve')::integer AS reserves,
   count(*) FILTER(WHERE l.kind='settle')::integer AS settlements,
   COALESCE(sum(l.delta_available),0)::text AS available,COALESCE(sum(l.delta_held),0)::text AS held,
   COALESCE(sum(CASE WHEN l.account_id=p.buyer_account_id THEN l.delta_available ELSE 0 END),0)::text AS buyer,
   COALESCE(sum(CASE WHEN l.account_id=p.seller_account_id THEN l.delta_available ELSE 0 END),0)::text AS seller
   FROM (SELECT * FROM ac_game_market_purchases WHERE state='settled' AND delivery_receipt->>'assigned'='true'
    AND delivery_receipt->>'purchaseId'=purchase_id::text ORDER BY updated_at DESC LIMIT 10) p
   LEFT JOIN ac_game_market_ledger l ON l.purchase_id=p.purchase_id
   GROUP BY p.purchase_id,p.item,p.count,p.price,p.updated_at,p.buyer_account_id,p.seller_account_id ORDER BY p.updated_at DESC`)).rows
  return rows.filter(value=>value.legs===3&&value.reserves===1&&value.settlements===2&&BigInt(value.available)===0n&&BigInt(value.held)===0n&&BigInt(value.buyer)===-BigInt(value.price)&&BigInt(value.seller)===BigInt(value.price))
   .map(value=>{const key='market-purchase:'+value.purchase_id;return{feed:'transactions',key,occurredAt:+new Date(value.updated_at),payload:payload('transactions',key,{title:'GAME COINS · marketplace purchase',description:'Paid against backed Minecraft items assigned to the buyer’s private mailbox.',fields:[field('Items',`${value.count} ${value.item}`),field('Amount',value.price+' Game Coins'),field('State','Paid · items assigned to buyer')],color:0xf1c40f})}})
 }
 async function publicReceipts(){
  if(typeof verifyPublicReceipt!=='function'||!await table('ac_playable_testnet_chain_intents')||!await table('ac_playable_testnet_requests')||!await table('ac_playable_testnet_wallets'))return[]
  // World-asset stages have their own semantic receipt cards. Do not also
  // label their approval/purchase transactions as legacy demonstration swaps.
  const assetHashes=new Set()
  if(await table('ac_world_asset_records'))for(const value of(await pool.query(`SELECT stage.value->>'transactionHash' hash FROM ac_world_asset_records r
   CROSS JOIN LATERAL jsonb_each(COALESCE(r.body->'stages','{}'::jsonb)) stage WHERE starts_with(r.record_key,'operation:')`)).rows)if(HASH.test(value.hash||''))assetHashes.add(value.hash.toLowerCase())
  const rows=(await pool.query(`SELECT i.operation_id,i.transaction_hash,i.chain_instance,i.status,i.created_at,
   i.receipt->>'transactionHash' AS receipt_hash,i.receipt->>'blockHash' AS block_hash,
   i.receipt->>'blockNumber' AS block_number,i.receipt->>'status' AS receipt_status
   FROM ac_playable_testnet_chain_intents i JOIN ac_playable_testnet_requests r USING(operation_id)
   JOIN ac_playable_testnet_wallets w USING(wallet_id)
   WHERE w.environment='UNICHAIN_SEPOLIA_PLAYABLE' AND w.provider_type='privy' AND i.chain_instance LIKE '1301:%'
   AND i.receipt IS NOT NULL AND i.status IN ('confirmed','reverted','reorganized') ORDER BY i.created_at DESC,i.operation_id LIMIT 10`)).rows
  const result=[]
  for(const row of rows){
   if(assetHashes.has(row.transaction_hash?.toLowerCase()))continue
   if(!HASH.test(row.transaction_hash)||row.receipt_hash?.toLowerCase()!==row.transaction_hash.toLowerCase()||!HASH.test(row.block_hash)||!/^\d+$/.test(row.block_number||''))continue
   const candidate={operationId:row.operation_id,transactionHash:row.transaction_hash,chainId:1301,chainInstance:row.chain_instance,recordedStatus:row.status,
    receipt:{transactionHash:row.receipt_hash,blockHash:row.block_hash,blockNumber:row.block_number,status:row.receipt_status}}
   let proof
   try{proof=await verifyPublicReceipt(candidate)}catch{continue}
   const verified=proof?.verified===true&&proof.chainId===1301&&proof.transactionHash?.toLowerCase()===row.transaction_hash.toLowerCase()&&
    proof.blockHash?.toLowerCase()===row.block_hash.toLowerCase()&&String(proof.blockNumber)===row.block_number&&Number.isSafeInteger(proof.confirmations)&&proof.confirmations>=2&&
    (proof.status==='confirmed'&&row.receipt_status==='success'||proof.status==='reverted'&&row.receipt_status==='reverted')
   const key='public-receipt:'+row.operation_id
   if(!verified){
    const existing=(await pool.query('SELECT message_id FROM ac_discord_activity_projections WHERE server_id=$1 AND feed=$2 AND source_key=$3',[serverId,'transactions',key])).rows[0]
    if(existing?.message_id)result.push({feed:'transactions',key,occurredAt:+new Date(row.created_at),payload:payload('transactions',key,{title:'UNICHAIN SEPOLIA · receipt reconciliation',description:'The previously displayed receipt is no longer verified. Awaiting canonical reconciliation.',fields:[field('Record',digest(row.operation_id).slice(0,8))],color:0xe67e22})})
    continue
   }
   result.push({feed:'transactions',key,occurredAt:+new Date(row.created_at),payload:payload('transactions',key,{title:'UNICHAIN SEPOLIA · testnet receipt',url:'https://sepolia.uniscan.xyz/tx/'+row.transaction_hash,description:'Verified testnet transaction. Asset ownership and Minecraft application require their own confirmed contract events and game status.',fields:[field('Record',digest(row.operation_id).slice(0,8)),field('Transaction hash',row.transaction_hash),field('State',proof.status==='confirmed'?'Confirmed · canonical receipt':'Reverted · canonical receipt'),field('Block',row.block_number),field('Confirmations',proof.confirmations)],color:proof.status==='confirmed'?0x2ecc71:0xe74c3c})})
  }
  return result
 }
 async function worldAssets(){
  if(typeof worldAssetViews!=='function')return[]
  let views
  try{views=await worldAssetViews()}
  catch{
   const previous=(await pool.query("SELECT feed,source_key FROM ac_discord_activity_projections WHERE server_id=$1 AND source_key LIKE 'world-asset:%'",[serverId])).rows
   return previous.map(row=>({feed:row.feed,key:row.source_key,occurredAt:0,payload:payload(row.feed,row.source_key,{title:'Blockchain asset · verification paused',description:'Waiting for current canonical chain evidence. Preview and purchase controls are paused.',color:0xe67e22})}))
  }
  const values=[]
  for(const asset of(views.assets||[]).slice(0,10)){
   if(!/^[1-9][0-9]{0,77}$/.test(asset.tokenId)||!['item','parcel'].includes(asset.kind))continue
   const key='world-asset:'+asset.tokenId,listed=asset.listing?.active===true,price=asset.listing?.priceBaseUnits
   if(listed&&!/^[1-9][0-9]*$/.test(price||''))continue
   const description=String(asset.kind==='item'?`${asset.count??1} × ${asset.descriptor?.name||asset.descriptor?.material||'Exact registered item'}`:asset.parcelId).slice(0,300)
   const body=payload('marketplace',key,{title:`${asset.kind==='parcel'?'LAND + HOUSE':'ITEM'} · asset ${asset.tokenId}`,description,
    fields:[field('State',asset.redeemed?'Redeemed':listed?'Listed on Unichain Sepolia':'Owned · not listed'),...(listed?[field('Total price',formatUnits(BigInt(price),18)+' CITY')]:[])],color:listed?0x37a77a:0x7f8c8d})
   if(listed)body.components=[{type:1,components:[{type:2,custom_id:'ac:asset-buy:'+asset.tokenId,label:'Preview on-chain purchase',style:1}]}]
   values.push({feed:'marketplace',key,occurredAt:Date.now(),payload:body})
  }
  const events=new Set(['AssetRegistered','AssetListed','AssetPurchased','AssetListingCancelled','RedemptionFinalized','ParcelSnapshotUpdated'])
  for(const receipt of(views.receipts||[]).slice(0,10)){
   if(!HASH.test(receipt.transactionHash||'')||!HASH.test(receipt.blockHash||'')||!events.has(receipt.eventName)||!Number.isSafeInteger(receipt.confirmations)||receipt.confirmations<2)continue
   const key='world-asset:receipt:'+receipt.transactionHash
   values.push({feed:'transactions',key,occurredAt:Date.now(),payload:payload('transactions',key,{title:'WORLD ASSET · '+receipt.eventName,url:'https://sepolia.uniscan.xyz/tx/'+receipt.transactionHash,
    description:'Confirmed asset contract event on Unichain Sepolia. Game application and item collection have their own status.',fields:[field('Asset',receipt.tokenId||'registered asset'),field('Transaction',receipt.transactionHash),field('State','Canonical · at least two confirmations')],color:0x37a77a})})
  }
  return values
 }
 async function archivedStock(){
  if(!onchainOnly)return[]
  const previous=(await pool.query("SELECT feed,source_key FROM ac_discord_activity_projections WHERE server_id=$1 AND (source_key LIKE 'listing:%' OR source_key LIKE 'market-purchase:%' OR source_key LIKE 'game-transfer:%')",[serverId])).rows
  const listings=await table('ac_game_market_listings')?(await pool.query("SELECT listing_id,state FROM ac_game_market_listings WHERE stock_receipt->>'escrowed'='true' AND state IN ('open','return_pending')")).rows:[]
  for(const listing of listings)if(!previous.some(row=>row.source_key==='listing:'+listing.listing_id))previous.push({feed:'marketplace',source_key:'listing:'+listing.listing_id})
  return previous.map(row=>{
   const original=listings.find(listing=>row.source_key==='listing:'+listing.listing_id)
   const body=payload(row.feed,row.source_key,{title:row.feed==='marketplace'?'Older stock · withdrawal only':'Archived receipt',description:row.feed==='marketplace'?'New sales use CITY on Unichain Sepolia. The original owner can withdraw this earlier escrowed stock, claim it, then separately register it on chain.':'This historical receipt is retained. Current payments use the on-chain CITY marketplace.',color:0x7f8c8d})
   if(original)body.components=[{type:1,components:[{type:2,custom_id:'ac:market-cancel:'+original.listing_id,label:'Withdraw my original stock',style:2}]}]
   return{feed:row.feed,key:row.source_key,occurredAt:0,payload:body}
  })
 }
 async function project(value){
  const keyMarker=marker(value.feed,value.key),nonce=BigInt('0x'+digest([serverId,value.feed,value.key]).slice(0,15)).toString()
  await pool.query(`INSERT INTO ac_discord_activity_projections(server_id,feed,source_key,payload,desired_digest,nonce,marker)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(server_id,feed,source_key) DO UPDATE SET payload=EXCLUDED.payload,
   desired_digest=EXCLUDED.desired_digest,updated_at=now()`,[serverId,value.feed,value.key,value.payload,digest(value.payload),nonce,keyMarker])
 }
 async function deliver(row,stats){
  const channel=await channelProvider(row.feed)
  if(!channel?.id||typeof channel.send!=='function'||typeof channel.edit!=='function'){stats.unavailable++;return}
  if(row.channel_id&&row.channel_id!==String(channel.id)){stats.blocked++;return}
  let messageId=row.message_id
  if(!messageId&&['sending','unknown'].includes(row.status)){
   if(typeof channel.findByNonce!=='function'){stats.blocked++;return}
   const found=await channel.findByNonce(row.nonce,row.marker)
   messageId=typeof found==='string'?found:found?.id
   if(!messageId){stats.blocked++;return}
   await pool.query('UPDATE ac_discord_activity_projections SET message_id=$4 WHERE server_id=$1 AND feed=$2 AND source_key=$3',[serverId,row.feed,row.source_key,String(messageId)])
  }
  if(messageId&&row.delivered_digest===row.desired_digest){stats.unchanged++;return}
  try{
   if(messageId){await channel.edit(String(messageId),row.payload);stats.edited++}
   else{
    await pool.query("UPDATE ac_discord_activity_projections SET status='sending',channel_id=$4 WHERE server_id=$1 AND feed=$2 AND source_key=$3",[serverId,row.feed,row.source_key,String(channel.id)])
    const sent=await channel.send({...row.payload,nonce:row.nonce,enforceNonce:true})
    if(!sent?.id)throw Error('ACTIVITY_MESSAGE_RECEIPT_REQUIRED')
    messageId=String(sent.id);stats.sent++
   }
   await pool.query("UPDATE ac_discord_activity_projections SET message_id=$4,channel_id=$5,delivered_digest=$6,status='sent',updated_at=now() WHERE server_id=$1 AND feed=$2 AND source_key=$3",[serverId,row.feed,row.source_key,messageId,String(channel.id),row.desired_digest])
  }catch{
   if(!messageId)await pool.query("UPDATE ac_discord_activity_projections SET status='unknown' WHERE server_id=$1 AND feed=$2 AND source_key=$3",[serverId,row.feed,row.source_key])
   stats.failed++
  }
 }
 async function sync(){
  if(closed)throw Error('ACTIVITY_FEED_CLOSED')
  if(running)return running
  running=(async()=>{
   const connection=await pool.connect(),stats={sent:0,edited:0,unchanged:0,blocked:0,unavailable:0,failed:0,publicVerifierConfigured:typeof verifyPublicReceipt==='function'}
   const lock='discord-activity:'+serverId
   try{
    await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock])
    const transactions=[...(onchainOnly?[]:await gameCoins()),...(onchainOnly?[]:await marketReceipts()),...await publicReceipts()].sort((a,b)=>b.occurredAt-a.occurredAt).slice(0,10)
    const values=[...await jobs(),...(onchainOnly?[]:await marketplace()),...transactions,...await worldAssets(),...await archivedStock()]
    for(const value of values)await project(value)
    for(const row of(await pool.query("SELECT * FROM ac_discord_activity_projections WHERE server_id=$1 ORDER BY updated_at DESC LIMIT 40",[serverId])).rows)await deliver(row,stats)
    return stats
   }finally{await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);connection.release()}
  })().finally(()=>{running=null})
  return running
 }
 return{sync,close:async()=>{closed=true;if(running)await running}}
}
