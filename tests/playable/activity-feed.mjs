// Isolated PG + Discord send/edit adapter fixtures. No real messages or money.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createActivityFeed} from '../../backend/src/discord/activity-feed.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_activity_feed_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.databaseUrl,max:1}),pool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema,max:4})
const report={status:'fail',scope:'Focused isolated PostgreSQL and Discord-adapter fixtures; no actual posting, financial writes or live blockchain verification',checks:[],sourceSha256:createHash('sha256').update(await readFile(new URL('../../backend/src/discord/activity-feed.mjs',import.meta.url))).digest('hex')}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false,feed
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query(`CREATE TABLE ac_discord_work_requests(id uuid,target_agent text,state text,specification text,quote jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE ac_game_transfers(transfer_id uuid,amount bigint,sender_id uuid,recipient_id uuid,state text,confirmed_at timestamptz DEFAULT now());
 CREATE TABLE ac_game_ledger(id bigserial,operation_key text,player_id uuid,kind text,delta_available bigint,delta_held bigint);
 CREATE TABLE ac_playable_testnet_wallets(wallet_id text,environment text,provider_type text,address text);
 CREATE TABLE ac_playable_testnet_requests(operation_id uuid,wallet_id text);
 CREATE TABLE ac_playable_testnet_chain_intents(operation_id uuid,transaction_hash text,chain_instance text,status text,receipt jsonb,raw_transaction text,calldata text,created_at timestamptz DEFAULT now())`)
 const job=randomUUID(),task=randomUUID(),sender=randomUUID(),recipient=randomUUID(),payment=randomUUID(),invalid=randomUUID(),operation=randomUUID(),pending=randomUUID(),local=randomUUID()
 await pool.query("INSERT INTO ac_discord_work_requests(id,target_agent,state,specification,quote) VALUES($1,'DynamicAgent42','quoted','PRIVATE_JOB_TEXT', '{\"price\":\"987654321\"}')",[job])
 for(const[id,amount]of[[payment,7],[invalid,8]]){
  await pool.query("INSERT INTO ac_game_transfers(transfer_id,amount,sender_id,recipient_id,state) VALUES($1,$2,$3,$4,'confirmed')",[id,amount,sender,recipient])
  await pool.query("INSERT INTO ac_game_ledger(operation_key,player_id,kind,delta_available,delta_held) VALUES($1,$2,'transfer',-$4::bigint,0),($1,$3,'transfer',$5,0)",['transfer:'+id,sender,recipient,amount,id===payment?amount:amount-1])
 }
 const txHash='0x'+'1'.repeat(64),blockHash='0x'+'2'.repeat(64),genesis='0x'+'3'.repeat(64)
 await pool.query("INSERT INTO ac_playable_testnet_wallets VALUES('public','UNICHAIN_SEPOLIA_PLAYABLE','privy','PRIVATE_WALLET_ADDRESS'),('local','LOCAL_TEST_FIXTURE','local_fixture','PRIVATE_LOCAL_ADDRESS')")
 for(const[id,state,wallet,hash]of[[operation,'confirmed','public',txHash],[pending,'submitted','public','0x'+'4'.repeat(64)],[local,'confirmed','local','0x'+'5'.repeat(64)]]){
  await pool.query('INSERT INTO ac_playable_testnet_requests VALUES($1,$2)',[id,wallet])
  await pool.query("INSERT INTO ac_playable_testnet_chain_intents(operation_id,transaction_hash,chain_instance,status,receipt,raw_transaction,calldata) VALUES($1,$2,$3,$4,$5,'PRIVATE_RAW_BYTES','PRIVATE_CALLDATA')",[id,hash,(wallet==='public'?'1301:':'31337:')+genesis,state,{transactionHash:hash,blockHash,blockNumber:'100',status:'success'}])
 }
 const actualSources=async()=>({coins:(await pool.query('SELECT * FROM ac_game_ledger ORDER BY id')).rows,intents:(await pool.query('SELECT * FROM ac_playable_testnet_chain_intents ORDER BY operation_id')).rows})
 const before=await actualSources(),messages=new Map(),sends=[],edits=[]
 let loseFirstReply=true,publicCanonical=true
 const channels=Object.fromEntries(['jobs','transactions','marketplace'].map(kind=>[kind,{id:'fixture-'+kind,async send(payload){const message={id:String(messages.size+1),payload,channel:kind};messages.set(message.id,message);sends.push(message);if(loseFirstReply){loseFirstReply=false;throw Error('fixture lost reply after Discord mutation')}return{id:message.id}},async edit(id,payload){assert.equal(messages.get(id).channel,kind);messages.get(id).payload=payload;edits.push(id)},async findByNonce(nonce,marker){return[...messages.values()].find(message=>message.channel===kind&&(message.payload.nonce===nonce||message.payload.embeds[0].footer.text.includes(marker)))}}]))
 const slots=[{name:'DynamicAgent42',ownerName:'PRIVATE_OWNER_NAME',tasks:[{id:task,status:'running',completed:2,total:7,message:'PRIVATE_TASK_PROMPT'}]}]
 const watchedPool={connect:()=>pool.connect(),query:(sql,args)=>{if(/^\s*(?:INSERT|UPDATE|DELETE|ALTER)/i.test(sql)&&/\bac_(?:game|playable)_/i.test(sql))throw Error('Forbidden economic mutation');return pool.query(sql,args)}}
 const verification=[]
 feed=await createActivityFeed({pool:watchedPool,serverId:'fixture',channelProvider:kind=>channels[kind],agents:()=>slots,onchainOnly:false,
  verifyPublicReceipt:async candidate=>{verification.push(candidate);assert.equal(candidate.operationId,operation);return{verified:publicCanonical,chainId:1301,transactionHash:txHash,blockHash,blockNumber:'100',status:'confirmed',confirmations:2}}})
 const first=await feed.sync();assert.equal(first.failed,1)
 assert.equal(sends.length,4)
 const all=JSON.stringify([...messages.values()].map(message=>message.payload))
 for(const secret of ['PRIVATE_JOB_TEXT','987654321','PRIVATE_WALLET_ADDRESS','PRIVATE_LOCAL_ADDRESS','PRIVATE_RAW_BYTES','PRIVATE_CALLDATA','PRIVATE_OWNER_NAME','PRIVATE_TASK_PROMPT',sender,recipient])assert(!all.includes(secret))
 assert(all.includes('DynamicAgent42'));assert(all.includes('GAME COINS'));assert(all.includes('UNICHAIN SEPOLIA'))
 assert.equal([...messages.values()].filter(message=>message.payload.embeds[0].title.includes('GAME COINS')).length,1)
 assert.equal(verification.length,1);assert.equal(verification[0].chainId,1301)
 assert.deepEqual(await actualSources(),before)
 pass('redacted dynamic-agent jobs and distinct Game Coin versus verified public-testnet receipts omit private data invalid accounting submitted and local fixtures')
 await feed.close()
 feed=await createActivityFeed({pool:watchedPool,serverId:'fixture',channelProvider:kind=>channels[kind],agents:()=>slots,onchainOnly:false,
  verifyPublicReceipt:async()=>({verified:publicCanonical,chainId:1301,transactionHash:txHash,blockHash,blockNumber:'100',status:'confirmed',confirmations:2})})
 await feed.sync();assert.equal(sends.length,4)
 const recovered=(await pool.query("SELECT count(*) FROM ac_discord_activity_projections WHERE status='sent' AND message_id IS NOT NULL")).rows[0].count
 assert.equal(recovered,'4')
 slots[0].tasks[0].completed=7;slots[0].tasks[0].status='complete';await feed.sync();assert.equal(sends.length,4);assert(edits.length>=2)
 const afterEdit=edits.length;await feed.sync();assert.equal(edits.length,afterEdit)
 pass('durable unknown-send nonce marker reconciliation survives restart and edits each existing job card without duplicate posts')
 publicCanonical=false;await feed.sync()
 assert([...messages.values()].some(message=>message.payload.embeds[0].title.includes('receipt reconciliation')))
 assert.equal(sends.length,4)
 await feed.close()
 const noVerifierMessages=[]
 const omitted=await createActivityFeed({pool:watchedPool,serverId:'no-verifier',channelProvider:()=>({id:'fixture-none',send:async payload=>{noVerifierMessages.push(payload);return{id:String(noVerifierMessages.length)}},edit:async()=>{}}),agents:()=>slots})
 await omitted.sync();await omitted.close()
 assert(!JSON.stringify(noVerifierMessages).includes('UNICHAIN SEPOLIA'))
 assert.deepEqual(await actualSources(),before)
 pass('loss of canonical verification edits prior confirmation to reconciliation and absent verifier publishes no testnet confirmation while all economic records stay unchanged')
 await pool.query(`CREATE TABLE ac_game_market_listings(listing_id uuid,item text,count integer,price bigint,state text,created_at timestamptz DEFAULT now(),stock_receipt jsonb);
 CREATE TABLE ac_game_market_purchases(purchase_id uuid,item text,count integer,price bigint,state text,updated_at timestamptz DEFAULT now(),delivery_receipt jsonb,buyer_account_id uuid,seller_account_id uuid);
 CREATE TABLE ac_game_market_ledger(purchase_id uuid,account_id uuid,kind text,delta_available bigint,delta_held bigint)`)
 const lot=randomUUID(),unbacked=randomUUID(),trade=randomUUID(),badTrade=randomUUID()
 await pool.query("INSERT INTO ac_game_market_listings(listing_id,item,count,price,state,stock_receipt) VALUES($1,'minecraft:oak_planks',16,20,'open','{\"escrowed\":true}'),($2,'minecraft:diamond',64,1,'open','{\"escrowed\":false}')",[lot,unbacked])
 for(const id of[trade,badTrade]){
  await pool.query("INSERT INTO ac_game_market_purchases(purchase_id,item,count,price,state,delivery_receipt,buyer_account_id,seller_account_id) VALUES($1,'minecraft:oak_planks',16,20,'settled',$2,$3,$4)",[id,{assigned:true,purchaseId:id},sender,recipient])
  await pool.query("INSERT INTO ac_game_market_ledger VALUES($1,$2,'reserve',-20,20),($1,$2,'settle',0,-20),($1,$3,'settle',$4,0)",[id,sender,recipient,id===trade?20:19])
 }
 const marketLedgerBefore=(await pool.query('SELECT * FROM ac_game_market_ledger ORDER BY purchase_id,kind,account_id')).rows
 let worldViews={assets:[],receipts:[]},sourceUnavailable=false
 feed=await createActivityFeed({pool:watchedPool,serverId:'market-fixture',channelProvider:kind=>channels[kind],agents:()=>[],onchainOnly:false,worldAssetViews:async()=>{if(sourceUnavailable)throw Error('fixture canonical reader outage');return worldViews}})
 await feed.sync()
 const listingCards=[...messages.values()].filter(message=>message.channel==='marketplace');assert.equal(listingCards.length,1)
 assert.equal(listingCards[0].payload.components[0].components[0].custom_id,'ac:market-preview:'+lot)
 const tradeCards=[...messages.values()].filter(message=>message.payload.embeds[0].title==='GAME COINS · marketplace purchase');assert.equal(tradeCards.length,1)
 assert(!JSON.stringify(listingCards).includes('diamond'));assert(!JSON.stringify(tradeCards).includes(sender));assert(!JSON.stringify(tradeCards).includes(recipient))
 const totalMessages=messages.size;await pool.query("UPDATE ac_game_market_listings SET state='sold' WHERE listing_id=$1",[lot]);await feed.sync();assert.equal(messages.size,totalMessages)
 assert.equal(listingCards[0].payload.components,undefined)
 assert.deepEqual((await pool.query('SELECT * FROM ac_game_market_ledger ORDER BY purchase_id,kind,account_id')).rows,marketLedgerBefore)
 pass('only backed marketplace lots receive purchase previews; exact conserved trade receipts publish once and sold lots lose purchase controls')
 worldViews={assets:[{tokenId:'9',kind:'parcel',parcelId:'estate-0-0',listing:{active:true,priceBaseUnits:'12500000000000000000'}}],receipts:[{transactionHash:'0x'+'d'.repeat(64),blockHash:'0x'+'e'.repeat(64),confirmations:2,eventName:'AssetPurchased',tokenId:'9'}]}
 await feed.sync();const estateCard=[...messages.values()].find(message=>message.payload.embeds[0].title==='LAND + HOUSE · asset 9')
 assert(estateCard);assert.equal(estateCard.payload.components[0].components[0].custom_id,'ac:asset-buy:9');assert(JSON.stringify(estateCard).includes('12.5 CITY'))
 assert([...messages.values()].some(message=>message.payload.embeds[0].title==='WORLD ASSET · AssetPurchased'))
 const marketCount=messages.size;sourceUnavailable=true;await feed.sync();assert.equal(messages.size,marketCount);assert.equal(estateCard.payload.components,undefined);assert.match(estateCard.payload.embeds[0].title,/verification paused/)
 pass('canonical asset-reader fixture produces exact CITY land purchase controls and hash-linked receipts; source outage edits the same cards and removes purchase controls')
 await feed.close();sourceUnavailable=false
 await pool.query("UPDATE ac_game_market_listings SET state='open' WHERE listing_id=$1",[lot])
 feed=await createActivityFeed({pool:watchedPool,serverId:'market-fixture',channelProvider:kind=>channels[kind],agents:()=>[],worldAssetViews:async()=>worldViews})
 await feed.sync()
 const currentCards=(await pool.query("SELECT payload FROM ac_discord_activity_projections WHERE server_id='market-fixture'")).rows.map(row=>row.payload)
 assert(!JSON.stringify(currentCards).includes('Game Coins'));assert(!JSON.stringify(currentCards).includes('GAME COINS'));assert(!JSON.stringify(currentCards).includes('ac:market-preview:'))
 assert(JSON.stringify(currentCards).includes('ac:market-cancel:'+lot));assert(JSON.stringify(currentCards).includes('CITY'))
 assert.deepEqual((await pool.query('SELECT * FROM ac_game_market_ledger ORDER BY purchase_id,kind,account_id')).rows,marketLedgerBefore)
 pass('default on-chain feed replaces earlier sale/payment cards with withdrawal-only archives and CITY controls without changing any economic record')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{if(feed)await feed.close();await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();const directory=join(root,'evidence/runs/discord-activity-feed',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
