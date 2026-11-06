'use strict'
// Operator-run native gate fixture. No real Discord user, wallet, item grant or
// build is involved. Do not run until the root coordinates server upgrade.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{once}=require('node:events')
const root=path.resolve(__dirname,'../..')
require(path.join(root,'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer=require(path.join(root,'tests/compatibility/node_modules/mineflayer'))
const report={status:'fail',scope:'Disclosed GateTester and MicrosoftTester native fixtures; offline local profile approval is not Microsoft identity or an independent human',checks:[],independentHumansVerified:0,publicTransactions:0,worldBlocksChanged:0,itemGrants:0}
const clients=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let token,state
const check=(name,details={})=>{report.checks.push({name,status:'pass',...details});console.log(JSON.stringify({check:name,...details}))}
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),ms)})])}finally{clearTimeout(timer)}}
async function poll(read,accept,label){for(let i=0;i<100;i++){const value=await read();if(accept(value))return value;await delay(100)}throw Error(label+' timeout')}
async function api(route,body){const response=await fetch('http://127.0.0.1:25597/playable/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});return{status:response.status,body:await response.json()}}
async function ok(route,body){const result=await api(route,body);assert.equal(result.status,200,JSON.stringify(result));return result.body}
async function rejected(route,body){const result=await api(route,body);assert.ok(result.status>=400,'Receiving boundary must refuse invalid approval');return result.body}
const items=bot=>bot.inventory.items().map(item=>({name:item.name,count:item.count,slot:item.slot})).sort((a,b)=>a.slot-b.slot)
async function connect(name){await delay(4500);const bot=mineflayer.createBot({host:'127.0.0.1',port:25596,version:'1.21.11',auth:'offline',username:name,hideErrors:true});clients.push(bot);bot.messages=[];bot.on('messagestr',line=>{if(!line.includes('AC_SESSION'))bot.messages.push(line)});bot.on('error',()=>{});const record=packet=>{bot.observedWorld=packet.worldState?.name||bot.observedWorld};bot._client.on('login',record);bot._client.on('respawn',record);await bounded(Promise.race([once(bot,'spawn'),once(bot,'kicked').then(([reason])=>{throw Error(name+' admission refused: '+JSON.stringify(reason))})]),45000,name+' spawn');await delay(500);return bot}
async function save(){await fs.mkdir(path.join(root,'.local'),{recursive:true});await fs.writeFile(path.join(root,'.local/discord-access-fixture.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600})}
async function main(){
 const active=JSON.parse(await fs.readFile(path.join(root,'.local/playable-world/active.json'),'utf8'));assert.equal(active.owner,'agentcity-playable-pilot');assert.match(active.container,/^agentcity-playable-[a-f0-9]{8}$/)
 token=(await fs.readFile(path.join(root,'.local/playable-world',active.container,'api-token'),'utf8')).trim()
 try{state=JSON.parse(await fs.readFile(path.join(root,'.local/discord-access-fixture.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;state={local:{playerName:'GateTester',principalId:randomUUID(),discordId:'999000000000000001',accountKind:'local',expiresAtMs:Date.now()+86400000},microsoft:{playerName:'MicrosoftTester',principalId:randomUUID(),discordId:'999000000000000002',accountKind:'microsoft',expiresAtMs:Date.now()+86400000}};await save()}
 await ok('discord/reserve',state.local)
 let bot=await connect('GateTester'),session=await poll(()=>ok('session?playerId='+bot.player.uuid),value=>value.pendingAuthentication===true,'Local registration gate active')
 const runtime=path.join(root,'.local/playable-world',active.container),gateState=JSON.parse(await fs.readFile(path.join(runtime,'plugins/AgentCity/discord-game-access.json'),'utf8')),playableState=JSON.parse(await fs.readFile(path.join(runtime,'plugins/AgentCity/playable-state.json'),'utf8'))
 const held=gateState.holds[bot.player.uuid];assert.ok(held,'Original pre-gate location must have been persisted')
 const firstOnboarding=!(playableState.lobbyMigrated||[]).includes(bot.player.uuid)
 let baseline={world:'minecraft:'+held.world,position:[held.x,held.y,held.z],gameMode:held.gameMode.toLowerCase(),inventory:items(bot)}
 report.heldBaseline={...baseline,source:'Persisted pre-gate location/mode plus actual pending player inventory',firstOnboarding}
 await poll(()=>bot.game.gameMode,value=>value==='adventure','Pending Adventure mode');await poll(()=>bot.observedWorld,value=>value==='minecraft:agentcity_lobby','Restricted lobby world')
 const beforeMovement=await ok('session?playerId='+bot.player.uuid),pendingPosition=bot.entity.position.clone();assert.ok(beforeMovement.serverPosition&&beforeMovement.pendingPosition,'Authoritative server and held pending positions required')
 bot.setControlState('forward',true);await bounded(bot.waitForTicks(20),5000,'Frozen movement attempt');bot.clearControlStates();await delay(500)
 const afterMovement=await ok('session?playerId='+bot.player.uuid),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
 report.movementDiagnostic={serverBefore:beforeMovement.serverPosition,serverAfter:afterMovement.serverPosition,pendingAnchor:beforeMovement.pendingPosition,clientBefore:pendingPosition.toArray(),clientAfter:bot.entity.position.toArray(),clientDistance:bot.entity.position.distanceTo(pendingPosition),serverDistance:distance(beforeMovement.serverPosition,afterMovement.serverPosition),priorFailedReport:'evidence/runs/discord-game-access/98bd2f99-3c83-4643-b913-a69951380221/report.json',priorDiagnosis:'Parent verified persisted native position32.5,81,8.813426939524739 versus pending admission32.5,81,4.5; server actually moved. Replace destination rewrite with native movement cancellation to avoid the pending teleport guard vetoing a correction.'}
 assert.equal(afterMovement.serverPosition.world,beforeMovement.pendingPosition.world);assert.ok(distance(afterMovement.serverPosition,beforeMovement.pendingPosition)<0.01,'Authoritative server position stays at the actual pending anchor');assert.ok(distance(beforeMovement.serverPosition,beforeMovement.pendingPosition)<0.01,'Server begins at the held pending anchor')
 await poll(()=>bot.entity.position.distanceTo(pendingPosition),value=>value<0.2,'Native client movement correction after authoritative cancellation')
 report.movementDiagnostic.clientCorrected=bot.entity.position.toArray()
 const beforeEvents=(await ok('events')).events.filter(value=>value.playerId===bot.player.uuid).length
 bot.chat('/play');await delay(650);bot.chat('/agent status');await delay(1000)
 assert.equal(bot.observedWorld,'minecraft:agentcity_lobby');assert.equal((await ok('events')).events.filter(value=>value.playerId===bot.player.uuid).length,beforeEvents)
 assert.deepEqual(items(bot),baseline.inventory)
 check('registered-local-profile-frozen-in-adventure-lobby-commands-not-enqueued-inventory-preserved',{initialInventoryWasEmpty:baseline.inventory.length===0})
 const approval={playerId:bot.player.uuid,connectionId:session.connectionId,principalId:state.local.principalId}
 await rejected('discord/approve',{...approval,principalId:randomUUID()});await rejected('discord/approve',{...approval,connectionId:randomUUID()})
 assert.equal((await ok('session?playerId='+bot.player.uuid)).pendingAuthentication,true)
 check('wrong-principal-and-stale-connection-refused-without-releasing-gate')
 const receipt=await ok('discord/approve',approval);assert.equal(receipt.approved,true);assert.equal(receipt.principalId,state.local.principalId);assert.equal(receipt.connectionId,session.connectionId)
 await poll(()=>bot.game.gameMode,value=>value===(firstOnboarding?'survival':baseline.gameMode),'Approved game mode restored');await poll(()=>bot.observedWorld,value=>value===(firstOnboarding?'minecraft:agentcity_lobby':baseline.world),'Approved world restored')
 if(!firstOnboarding)assert.ok(bot.entity.position.distanceTo(new bot.entity.position.constructor(...baseline.position))<0.2,'Original position restored');assert.deepEqual(items(bot),baseline.inventory)
 assert.equal((await ok('session?playerId='+bot.player.uuid)).pendingAuthentication,false);assert.deepEqual(await ok('discord/approve',approval),receipt)
 check('exact-connection-single-use-approval-preserves-inventory-and-completes-normal-onboarding',{firstOnboarding})
 bot.chat('/play');await poll(()=>bot.observedWorld,value=>value==='minecraft:agentcity_play','Approved fixture enters play world');await delay(500)
 baseline={world:bot.observedWorld,position:bot.entity.position.toArray(),gameMode:bot.game.gameMode,inventory:items(bot)};state.baseline=baseline;await save()
 bot.quit('Gate fixture reconnect check');await delay(1000);bot=await connect('GateTester')
 const renewed=await poll(()=>ok('session?playerId='+bot.player.uuid),value=>value.pendingAuthentication===true,'Reconnect requires new approval');assert.notEqual(renewed.connectionId,approval.connectionId)
 await rejected('discord/approve',approval);await ok('discord/approve',{playerId:bot.player.uuid,connectionId:renewed.connectionId,principalId:state.local.principalId})
 await poll(()=>bot.observedWorld,value=>value===baseline.world,'Reconnect restores original play world');await poll(()=>bot.game.gameMode,value=>value===baseline.gameMode,'Reconnect restores original mode');assert.ok(bot.entity.position.distanceTo(new bot.entity.position.constructor(...baseline.position))<0.2,'Reconnect restores original position');assert.deepEqual(items(bot),baseline.inventory)
 check('new-connection-requires-new-approval-and-restores-original-play-state')
 await ok('discord/reserve',state.microsoft);const microsoft=await connect('MicrosoftTester'),pending=await poll(()=>ok('session?playerId='+microsoft.player.uuid),value=>value.pendingAuthentication===true,'Microsoft fixture pending')
 await rejected('discord/approve',{playerId:microsoft.player.uuid,connectionId:pending.connectionId,principalId:state.microsoft.principalId});assert.equal((await ok('session?playerId='+microsoft.player.uuid)).pendingAuthentication,true)
 const pendingList=(await ok('discord/pending')).pending;assert.ok(pendingList.some(value=>value.playerId===microsoft.player.uuid&&value.reason==='MICROSOFT_AUTHENTICATION_UNAVAILABLE'))
 check('offline-server-does-not-claim-Microsoft-identity-by-registered-name')
 await delay(4500);const unauthorized=mineflayer.createBot({host:'127.0.0.1',port:25596,version:'1.21.11',auth:'offline',username:'GateNo'+randomUUID().replaceAll('-','').slice(0,6),hideErrors:true});clients.push(unauthorized);unauthorized.on('error',()=>{})
 const [kick]=await bounded(Promise.race([once(unauthorized,'kicked'),once(unauthorized,'spawn').then(()=>{throw Error('Unregistered name bypassed whitelist')})]),15000,'Unregistered admission refusal');assert.match(JSON.stringify(kick),/whitelist/i)
 check('unregistered-name-still-refused-by-native-whitelist')
 report.status='pass'
}
main().catch(error=>{report.error=error.message;process.exitCode=1}).finally(async()=>{for(const bot of clients)if(bot._client?.state==='play')bot.quit('Disclosed Discord gate fixture finished');report.finishedAt=new Date().toISOString();const file=process.env.AC_PLAYABLE_TEST_REPORT||path.join(root,'evidence/runs/discord-game-access',randomUUID(),'report.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,error:report.error,evidence:file,checks:report.checks.length}))})
