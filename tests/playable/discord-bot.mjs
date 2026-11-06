import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { Collection, Events, ChannelType, PermissionsBitField, MessageFlags } from '../../backend/node_modules/discord.js/src/index.js'
import { createDiscordBridge, discordCommands, discordInvite, agentPanel, discordRequestDiagnostic, discordFailureMessage } from '../../backend/src/discord/bot.mjs'

const root=new URL('../../',import.meta.url),runId=randomUUID(),schema='discord_bot_fixture_'+runId.replaceAll('-','')
const configuration=JSON.parse(await readFile(new URL('.local/backend/environment.json',root),'utf8'))
const admin=new pg.Pool({connectionString:configuration.databaseUrl,max:1}),pool=new pg.Pool({connectionString:configuration.databaseUrl,options:'-c search_path='+schema,max:6})
const settings={enabled:true,applicationId:'880000000000000001',guildId:'770000000000000001',botToken:'fixture-not-a-real-discord-token'}
const owners=[{ownerId:randomUUID(),ownerName:'FixtureAlice',discordUserId:'660000000000000001'},{ownerId:randomUUID(),ownerName:'FixtureBob',discordUserId:'660000000000000002'},{ownerId:randomUUID(),ownerName:'FixtureCharlie',discordUserId:'660000000000000003'}]
const slots=owners.slice(0,2).map((owner,index)=>({name:'CityAgent'+(index+1),ownerId:owner.ownerId,ownerName:owner.ownerName,connected:true,mode:'wait',workflow:{status:'private-status-'+index,index:0,steps:[{}]}}))
const calls=[],grants=[],publicMessages=[],privateMessages=[],restCalls=[],marketCalls=[],report={status:'fail',scope:'Actual isolated PostgreSQL plus explicitly simulated Discord REST/Gateway/interactions; zero external posts, provider wallets or human verification',checks:[],publicDiscordPosts:0,actualGatewayConnections:0,independentHumansVerified:0,publicTransactions:0}
let bridge
const check=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function poll(read,accept,label){for(let i=0;i<100;i++){const value=await read();if(accept(value))return value;await delay(20)}throw Error(label+' timeout')}
function fakeClient({wrongApp=false,denyChannels=false}={}){
 const client=new EventEmitter();client.user={id:wrongApp?'880000000000000009':settings.applicationId};client.destroyed=false;client.channelCreates=0
 const makeChannel=(id,position,writable)=>({id,guildId:settings.guildId,type:ChannelType.GuildText,rawPosition:position,isTextBased:()=>true,
  permissionsFor:()=>({has:permission=>Array.isArray(permission)?writable&&!denyChannels:true}),messages:{fetch:async()=>new Collection()},send:async payload=>{publicMessages.push({channelId:id,payload});return{id:'990000000000000001'}}})
 const channels=new Collection([['550000000000000001',makeChannel('550000000000000001',0,false)],['550000000000000002',makeChannel('550000000000000002',1,true)]])
 const guild={id:settings.guildId,systemChannelId:'550000000000000001',members:{me:{id:client.user.id},fetch:async id=>{if(!owners.some(owner=>owner.discordUserId===id))throw Error('NOT_A_GUILD_MEMBER');return{id}}},channels:{fetch:async()=>channels,create:async()=>{client.channelCreates++;throw Error('CHANNEL_CREATION_FORBIDDEN')}}}
 client.guilds={fetch:async id=>{assert.equal(id,settings.guildId);return guild}}
 client.channels={fetch:async id=>channels.get(id)}
 client.users={fetch:async id=>({send:async payload=>{privateMessages.push({discordUserId:id,payload,transport:'fixture_dm'});return{id:'dm-'+privateMessages.length}}})}
 client.login=async token=>{assert.equal(token,settings.botToken);setImmediate(()=>client.emit(Events.ClientReady));return token}
 client.destroy=()=>{client.destroyed=true}
 return client
}
function interaction(user,index,type,values={}){
 const object={id:'fixture-interaction-'+index,user:{id:user.discordUserId,bot:false},guildId:settings.guildId,customId:values.customId,commandName:values.commandName,values:values.selected||[],responses:[],deferred:false,replied:false,
  options:{getString:name=>values[name]??null,getInteger:name=>values[name]??null,getUser:name=>values[name]?{id:values[name]}:null,getFocused:()=>values.focus||''},fields:{getTextInputValue:()=>values.message||''},
  isAutocomplete:()=>type==='autocomplete',isButton:()=>type==='button',isChatInputCommand:()=>type==='slash',isStringSelectMenu:()=>type==='select',isModalSubmit:()=>type==='modal',
  deferReply:async payload=>{assert.equal(payload.flags,MessageFlags.Ephemeral);object.deferred=true},editReply:async payload=>{object.responses.push(payload);object.replied=true;return{id:'edited'}},reply:async payload=>{assert.equal(payload.flags,MessageFlags.Ephemeral);object.responses.push(payload);object.replied=true},
  showModal:async payload=>{object.modal=payload;object.replied=true},followUp:async payload=>{assert.equal(payload.flags,MessageFlags.Ephemeral);privateMessages.push({discordUserId:user.discordUserId,payload,transport:'fixture_ephemeral'});return{id:'follow-'+privateMessages.length}},respond:async payload=>{object.autocomplete=payload}}
 return object
}
const identity={getOwner:async id=>{const owner=owners.find(value=>value.discordUserId===id);if(!owner)throw Error('DISCORD_PRIVY_LINK_REQUIRED');return owner},issueGrant:async input=>{grants.push(input);return{fixture:true,ownerId:owners.find(owner=>owner.discordUserId===input.discordUserId).ownerId}},beginSetup:async()=>({loginUrl:'https://example.invalid/fixture-only'})}
const agents={status:()=>slots,handleRemote:async request=>{calls.push(request);return'Fixture remote action '+request.action}}
const listingId=randomUUID(),purchaseId=randomUUID(),marketplace={handleDiscord:async request=>{
 marketCalls.push(request)
 if(request.action==='list')return{message:'Review 16 oak planks for 20 Game Coins from your agent.',confirmation:{action:'confirm_listing',id:listingId}}
 if(request.action==='confirm_listing'){if(request.userId!==owners[0].discordUserId)throw Error('Only the listing owner can confirm.');return{message:'Listing backed by reserved items.'}}
 if(request.action==='buy')return{message:'Review the exact 20 Game Coin purchase.',confirmation:{action:'confirm_buy',id:purchaseId}}
 return{message:'Purchase submitted for backed delivery.'}
}}
const assetCalls=[],worldAssets={handleDiscord:async request=>{assetCalls.push(request);if(request.action==='register_item')return{message:'Review the exact sword.',operation:{operationId:'discord:asset-preview',action:'mint',status:'preview',terms:{nativePreview:{descriptor:{material:'diamond_sword',enchants:{sharpness:2}}}}},confirmation:{kind:'asset',operationId:'discord:asset-preview'}};return{message:'Fixture original asset operation confirmed.'}}}
const restClient={put:async(route,payload)=>{restCalls.push({route,payload});return payload.body}}
const controlIds=panel=>panel.components.flatMap(component=>component.toJSON().components.map(button=>button.custom_id)).filter(Boolean)
try{
 await admin.query('CREATE SCHEMA '+schema)
 await pool.query('CREATE TABLE ac_discord_identities(principal_id uuid PRIMARY KEY,discord_user_id text UNIQUE NOT NULL)')
 for(const owner of owners)await pool.query('INSERT INTO ac_discord_identities VALUES($1,$2)',[owner.ownerId,owner.discordUserId])
 const commands=discordCommands();assert.equal(new Set(commands.map(command=>command.name)).size,commands.length)
 for(const command of commands){assert.match(command.name,/^[a-z][a-z0-9_-]{0,31}$/);assert.ok(command.description.length<=100);assert.ok((command.options||[]).length<=25)}
 assert.deepEqual(commands.find(value=>value.name==='profile').options.find(value=>value.name==='login').choices.map(choice=>choice.value),['local','microsoft'])
 const invite=new URL(discordInvite(settings)),permissions=new PermissionsBitField(BigInt(invite.searchParams.get('permissions')));assert.equal(permissions.has(PermissionsBitField.Flags.Administrator),false);assert.equal(permissions.has(PermissionsBitField.Flags.ManageChannels),false)
 assert.ok(controlIds(agentPanel(slots[0],owners[0].ownerId)).some(id=>id.startsWith('ac:screenshot:')));assert.deepEqual(controlIds(agentPanel(slots[1],owners[0].ownerId)),['ac:work:CityAgent2'])
 const renamed=agentPanel({...slots[0],provider:'anthropic',ownerName:'CompareClaude'},owners[0].ownerId,{identityOnly:true}).embeds[0].toJSON()
 assert.match(renamed.title,/Agent/);assert(!renamed.title.includes('Claude'))
 check('command-schema-and-own-versus-foreign-agent-panel-controls')
 const client=fakeClient(),screenshotDirectory=fileURLToPath(new URL('.local/discord-bot-fixture/'+runId+'/',root))
 await mkdir(screenshotDirectory,{recursive:true})
 bridge=await createDiscordBridge({settings,pool,identity,agents,client,restClient,screenshotDirectory,marketplace,worldAssets,allowLegacyGameCoinsFixture:true})
 await bridge.start();await poll(()=>bridge.ready||bridge.startupError,Boolean,'Fixture ready event');assert.equal(bridge.startupError,null);assert.equal(bridge.ready,true);assert.equal(restCalls.length,1);assert.equal(publicMessages.length,1);assert.equal(publicMessages[0].channelId,'550000000000000002');assert.equal(client.channelCreates,0)
 const unavailableMicrosoft=interaction(owners[0],'microsoft-unavailable','slash',{commandName:'profile',name:'FixtureAlice',login:'microsoft'})
 await bridge.interaction(unavailableMicrosoft);assert.match(unavailableMicrosoft.responses.at(-1).content,/Microsoft account verification is unavailable/)
 assert.equal(calls.length,0);assert.equal(grants.length,0)
 identity.reserveMinecraft=async()=>{throw Error('EXISTING_MINECRAFT_OWNER_LOGIN_REQUIRED')}
 const occupiedName=interaction(owners[0],'occupied-minecraft-name','slash',{commandName:'profile',name:'ruddy',login:'local'})
 await bridge.interaction(occupiedName);assert.match(occupiedName.responses.at(-1).content,/fresh name such as Ruddy2/)
 assert.equal(calls.length,0);assert.equal(grants.length,0)
 const forged=interaction(owners[0],'foreign-screenshot','button',{customId:'ac:screenshot:CityAgent2'});await bridge.interaction(forged);assert.match(forged.responses.at(-1).content,/Only the owner/);assert.equal(calls.length,0)
 const forgedModal=interaction(owners[0],'foreign-modal','button',{customId:'ac:ask:CityAgent2'});await bridge.interaction(forgedModal);assert.equal(forgedModal.modal,undefined);assert.equal(calls.length,0)
 const workModal=interaction(owners[0],'work-modal','button',{customId:'ac:work:CityAgent2'});await bridge.interaction(workModal);assert.equal(workModal.modal.toJSON().custom_id,'ac:work-submit:CityAgent2')
 await assert.rejects(bridge.panel('660000000000000099'),/NOT_A_GUILD_MEMBER/)
 assert.equal(await bridge.execute(owners[0].discordUserId,'own-status','status'),'Fixture remote action status');await bridge.execute(owners[0].discordUserId,'own-status','status');assert.equal(calls.length,1);assert.equal(grants.length,1)
 await assert.rejects(bridge.execute(owners[0].discordUserId,'own-status','status','different'),/DISCORD_COMMAND_ID_CONFLICT/)
 check('existing-writable-channel-fallback-owner-gates-and-stable-command-replay')
 const request=interaction(owners[0],'request','slash',{commandName:'work',request:'Build a three-block wall using my materials.',agent:'CityAgent2'});await bridge.interaction(request)
 const work=(await pool.query('SELECT * FROM ac_discord_work_requests')).rows[0];assert.equal(work.requester_id,owners[0].ownerId);assert.equal(work.target_owner_id,owners[1].ownerId)
 const changed=interaction(owners[0],'request','slash',{commandName:'work',request:'Changed scope',agent:'CityAgent2'});await bridge.interaction(changed);assert.equal((await pool.query('SELECT count(*)::int n FROM ac_discord_work_requests')).rows[0].n,1)
 await assert.rejects(bridge.createWork(owners[0].discordUserId,'ambiguous-target',{agent:'CityAgent2',person:owners[1].discordUserId},'Work'),/exactly one/)
 const offer=interaction(owners[1],'offer1','slash',{commandName:'offer',job:work.id,price:'5',asset:'GAME_COINS',scope:'Three-block wall; requester provides three planks.'});await bridge.interaction(offer)
 const firstQuote=(await bridge.workOrders.get({workId:work.id,actorOwnerId:owners[0].ownerId})).quote
 const revised=interaction(owners[1],'offer2','slash',{commandName:'offer',job:work.id,price:'6',asset:'GAME_COINS',scope:'Three-block wall; requester provides three planks.'});await bridge.interaction(revised)
 const active=await bridge.workOrders.get({workId:work.id,actorOwnerId:owners[0].ownerId});assert.notEqual(active.quote.quoteId,firstQuote.quoteId)
 const stale=interaction(owners[0],'accept-stale','button',{customId:'ac:accept:'+work.id+':'+firstQuote.quoteId});await bridge.interaction(stale);assert.match(stale.responses.at(-1).content,/quote was revised/)
 const outsider=interaction(owners[2],'accept-foreign','button',{customId:'ac:accept:'+work.id+':'+active.quote.quoteId});await bridge.interaction(outsider);assert.equal((await bridge.workOrders.get({workId:work.id,actorOwnerId:owners[0].ownerId})).state,'quoted')
 const accept=interaction(owners[0],'accept-current','button',{customId:'ac:accept:'+work.id+':'+active.quote.quoteId});await bridge.interaction(accept)
 const accepted=await bridge.workOrders.get({workId:work.id,actorOwnerId:owners[0].ownerId});assert.equal(accepted.state,'terms_accepted_awaiting_funding');assert.equal(accepted.acceptedQuoteId,active.quote.quoteId);assert.equal(accepted.executionAuthorized,false);assert.equal(accepted.funded,false);assert.equal(calls.length,1)
 check('work-request-quote-revision-and-requester-acceptance-retain-immutable-references-without-execution')
 const image=join(screenshotDirectory,'fixture.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==','base64'))
 const ownImage=interaction(owners[0],'screenshot-sink','button',{customId:'ac:screenshot:CityAgent1'});await bridge.interaction(ownImage)
 await bridge.notifyOwner(owners[0].ownerId,'Synthetic attachment transport fixture',{file:image,metadata:{observedAt:'2026-10-31T00:00:00.000Z'}})
 await bridge.flush();await poll(()=>pool.query("SELECT count(*)::int n FROM ac_discord_notifications WHERE attachment_path IS NOT NULL AND status='sent'").then(value=>value.rows[0].n),value=>value===1,'Private attachment delivery')
 const attached=privateMessages.filter(value=>value.payload.files?.length);assert.equal(attached.length,1);assert.equal(attached[0].discordUserId,owners[0].discordUserId);assert.equal(attached[0].transport,'fixture_ephemeral');assert.equal(attached[0].payload.files[0].description,'Observed world rendering, 2026-10-31T00:00:00.000Z');assert.ok(publicMessages.every(value=>!value.payload.files))
 await assert.rejects(bridge.notifyOwner(owners[0].ownerId,'Forbidden',{file:join(screenshotDirectory,'..','outside.png')}),/DISCORD_SCREENSHOT_PATH_REFUSED/)
 check('screenshot-attachments-stay-owner-private-and-use-observation-timestamp')
 const cancel=interaction(owners[0],'cancel-owned','button',{customId:'ac:cancel:CityAgent1'})
 await bridge.interaction(cancel);assert.equal(calls.at(-1).action,'cancel');assert.equal(calls.at(-1).ownerId,owners[0].ownerId)
 const countAfterCancel=calls.length;await bridge.interaction(cancel);assert.equal(calls.length,countAfterCancel)
 const foreignCancel=interaction(owners[1],'cancel-foreign','button',{customId:'ac:cancel:CityAgent1'})
 await bridge.interaction(foreignCancel);assert.equal(calls.length,countAfterCancel)
 check('cancel-control-is-owner-only-and-interaction-retries-do-not-repeat-agent-command')
 const listing=interaction(owners[0],'market-list','slash',{commandName:'bazaar',action:'list',item:'oak_planks',count:16,price:'20',source:'agent'})
 await bridge.interaction(listing);assert.deepEqual(marketCalls.at(-1).args,{item:'oak_planks',count:16,price:'20',source:'agent'});assert.equal(marketCalls.at(-1).action,'list')
 assert.equal(listing.responses.at(-1).components[0].toJSON().components[0].custom_id,'ac:market-listing:'+listingId)
 await bridge.interaction(interaction(owners[1],'foreign-list-confirm','button',{customId:'ac:market-listing:'+listingId}))
 assert.equal(marketCalls.at(-1).userId,owners[1].discordUserId)
 await bridge.interaction(interaction(owners[0],'own-list-confirm','button',{customId:'ac:market-listing:'+listingId}));assert.equal(marketCalls.at(-1).action,'confirm_listing')
 const buyPreview=interaction(owners[1],'buy-preview','button',{customId:'ac:market-preview:'+listingId});await bridge.interaction(buyPreview)
 assert.equal(marketCalls.at(-1).action,'buy');assert.equal(buyPreview.responses.at(-1).components[0].toJSON().components[0].custom_id,'ac:market-buy:'+purchaseId)
 await bridge.interaction(interaction(owners[1],'buy-confirm','button',{customId:'ac:market-buy:'+purchaseId}));assert.equal(marketCalls.at(-1).action,'confirm_buy')
 check('Game Coin marketplace uses explicit listing and purchase previews with separate verified-user confirmation interactions')
 const selfPurchase=discordFailureMessage(Object.assign(Error('GAME_MARKET_CANNOT_BUY_OWN_LISTING'),{code:'GAME_MARKET_CANNOT_BUY_OWN_LISTING'}))
 assert.match(selfPurchase,/your own listing/);assert.match(selfPurchase,/Another player/);assert.match(selfPurchase,/action:cancel/);assert.doesNotMatch(selfPurchase,/account setup/)
 check('self-purchase refusal explains ownership and original-listing withdrawal without suggesting broken identity setup')
 const assetPreview=interaction(owners[0],'world-asset-preview','slash',{commandName:'assets',action:'register_item',source:'player'});await bridge.interaction(assetPreview)
 assert.equal(assetCalls.at(-1).action,'register_item');assert.equal(assetCalls.at(-1).userId,owners[0].discordUserId);assert.equal(assetCalls.length,1)
 const assetConfirm=interaction(owners[0],'world-asset-confirm','button',{customId:'ac:asset-confirm:discord%3Aasset-preview'});await bridge.interaction(assetConfirm)
 assert.equal(assetCalls.at(-1).action,'confirm');assert.equal(assetCalls.at(-1).args.operationId,'discord:asset-preview');assert.equal(assetCalls.at(-1).operationId,'discord:fixture-interaction-world-asset-confirm')
 check('blockchain asset registration previews and explicit confirmations retain the actual Discord actor and original opaque operation ID')
 const diagnostic=discordRequestDiagnostic({code:10062,status:404,message:'sensitive provider payload',url:'https://example.invalid/private-token'},{commandName:'assets',createdTimestamp:Date.now()-4000},'acknowledgement',Date.now())
 assert.equal(diagnostic.code,'10062');assert.equal(diagnostic.stage,'acknowledgement');assert.equal(diagnostic.httpStatus,404);assert(diagnostic.receivedAgeMs>=3990)
 assert(!JSON.stringify(diagnostic).includes('sensitive'));assert(!JSON.stringify(diagnostic).includes('private-token'))
 const expired=interaction(owners[0],'expired-market-confirm','button',{customId:'ac:market-listing:'+listingId})
 expired.deferReply=async()=>{throw Object.assign(Error('Unknown interaction'),{code:10062,status:404})}
 const beforeExpired={market:marketCalls.length,assets:assetCalls.length,agents:calls.length,grants:grants.length}
 await bridge.interaction(expired)
 assert.deepEqual({market:marketCalls.length,assets:assetCalls.length,agents:calls.length,grants:grants.length},beforeExpired)
 check('expired initial acknowledgements execute no inventory/payment/agent operation and diagnostics retain numeric Discord codes without private provider payloads')
 const thirdAgent=interaction(owners[2],'third-agent-capacity','button',{customId:'ac:create:self'})
 await bridge.interaction(thirdAgent)
 assert.equal(grants.at(-1).slotName,'CityAgent3')
 assert.equal(grants.at(-1).agentId,'CityAgent3')
 assert.equal(calls.at(-1).ownerId,owners[2].ownerId)
 assert.equal(calls.at(-1).action,'create')
 assert.deepEqual(slots.map(slot=>slot.ownerId),owners.slice(0,2).map(owner=>owner.ownerId))
 check('third Discord owner receives a scoped CityAgent3 grant without taking either occupied slot')
 await bridge.close();bridge=null
 const badClient=fakeClient({wrongApp:true}),bad=await createDiscordBridge({settings,pool,identity,agents,client:badClient,restClient});await assert.rejects(bad.start(),/DISCORD_BOT_APPLICATION_MISMATCH/);assert.equal(bad.ready,false);assert.equal(bad.startupError,'DISCORD_BOT_APPLICATION_MISMATCH');assert.equal(badClient.destroyed,true);await bad.close()
 const restFailureClient=fakeClient(),restFailure=await createDiscordBridge({settings,pool,identity,agents,client:restFailureClient,restClient:{put:async()=>{await Promise.resolve();throw Error('FIXTURE_COMMAND_REGISTRATION_FAILED')}}});await assert.rejects(restFailure.start(),/FIXTURE_COMMAND_REGISTRATION_FAILED/);assert.equal(restFailure.ready,false);assert.equal(restFailureClient.destroyed,true);assert.equal(publicMessages.length,1,'Failed REST registration never publishes another directory');await restFailure.close()
 check('asynchronous-ready-errors-are-caught-and-do-not-mark-the-bridge-ready')
 const organizedDeliveries=[],organizedClient=fakeClient()
 const organized=await createDiscordBridge({settings:{...settings,organizedServer:true},pool,identity,agents,client:organizedClient,restClient,marketplace,worldAssets,
  experienceFactory:async()=>({start:async()=>{},panel:async owner=>({content:'Your private room: <#550000000000000003>',allowedMentions:{parse:[]}}),
   deliver:async(ownerId,payload)=>{organizedDeliveries.push({ownerId,payload});return{id:'actual-adapter-fixture-receipt'}},status:()=>({configured:true}),close:async()=>{}})})
 await organized.start()
 const ownRoom=await organized.panel(owners[0].discordUserId);assert.match(ownRoom.content,/private room/);assert.equal(ownRoom.components,undefined)
 await organized.notifyOwner(owners[0].ownerId,'Private room progress');await organized.flush();await poll(()=>organizedDeliveries.length,value=>value===1,'Organized private delivery')
 assert.equal(organizedDeliveries.length,1);assert.equal(organizedDeliveries[0].ownerId,owners[0].ownerId)
 assert.equal(publicMessages.length,1,'Organized startup does not add another old general-channel panel')
 const retiredBefore=marketCalls.length
 await organized.interaction(interaction(owners[0],'stale-coin-list','slash',{commandName:'bazaar',action:'list',item:'stick',count:1,price:'4',source:'player'}))
 await organized.interaction(interaction(owners[1],'stale-coin-buy','button',{customId:'ac:market-preview:'+listingId}))
 assert.equal(marketCalls.length,retiredBefore,'retired slash and old purchase cards never dispatch a coin operation')
 const chainBrowse=interaction(owners[0],'onchain-browse','slash',{commandName:'bazaar',action:'browse'});await organized.interaction(chainBrowse)
 assert.equal(assetCalls.at(-1).action,'browse');assert.equal(marketCalls.length,retiredBefore)
 const sourceLot=interaction(owners[0],'register-plain-resource','slash',{commandName:'assets',action:'register_item',source:'player',count:3});await organized.interaction(sourceLot)
 assert.equal(assetCalls.at(-1).args.count,3)
 const commandText=JSON.stringify(discordCommands());assert(!/Game Coins/.test(commandText));assert(!discordCommands().find(c=>c.name==='bazaar').options[0].choices.some(c=>c.value==='list'||c.value==='buy'))
 check('default on-chain coordinator refuses stale coin buttons before effects and forwards resource count and CITY browse without coin controls')
 await organized.close()
 check('organized mode links the persistent private agent room and routes notifications without general-channel panels')
 report.status='pass';report.schema=schema
}catch(error){report.error=error.stack;process.exitCode=1}finally{
 if(bridge)await bridge.close();await pool.end();await admin.end()
 const directory=new URL('evidence/runs/discord-bot/'+runId+'/',root);await mkdir(directory,{recursive:true});await writeFile(new URL('report.json',directory),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:directory.pathname,error:report.error}))
}
