// Actual isolated native clients. No model, chain, real Discord/Privy login or payment is exercised.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inventoryShopEvent,inventoryShopPrices } from '../../backend/src/playable/inventory-shop-runtime.mjs'
import { SurvivalTools } from '../../backend/src/playable/survival-tools.mjs'

const root=resolve(new URL('../..',import.meta.url).pathname)
assert.equal(process.argv.length,2,'This check only accepts the owned isolated Mumbai-city descriptor')
const require=createRequire(new URL('../compatibility/package.json',import.meta.url))
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder')
const json=async file=>JSON.parse(await readFile(file,'utf8'))
const hash=value=>createHash('sha256').update(value).digest('hex')
const executedTestSha256=hash(await readFile(new URL(import.meta.url)))
const eventParserSourceSha256=hash(await readFile(new URL('../../backend/src/playable/inventory-shop-runtime.mjs',import.meta.url)))
const stable=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const meta=await json(join(root,'.local/mumbai-city/isolated-active.json'))
assert.equal(meta.owner,'agentcity-mumbai-city-isolated')
assert.match(meta.id,/^[a-f0-9]{32}$/)
assert.equal(meta.container,'agentcity-mumbai-city-'+meta.id.slice(0,8))
assert.equal(meta.gamePort,25996);assert.equal(meta.controlPort,25997)
assert.equal(resolve(meta.runtime),join(root,'.local/mumbai-city/isolated',meta.id))
const token=(await readFile(join(meta.runtime,'api-token'),'utf8')).trim()
assert.equal(hash(await readFile(join(meta.runtime,'plugins/AgentCity.jar'))),meta.pluginSha256)
const runId=randomUUID(),directory=join(root,'evidence/runs/mumbai-city',runId)
await mkdir(directory,{recursive:true})
const marker=join(root,'.local/mumbai-city/isolated-verification.json')
try {await rename(marker,marker+'.previous-'+runId)}catch(error){if(error.code!=='ENOENT')throw error}
const report={schema:'agentcity.mumbai-city-native-check.v1',runId,status:'fail',isolatedId:meta.id,executedTestSha256,eventParserSourceSha256,
  pluginSha256:meta.pluginSha256,serverId:meta.serverId,scope:'Actual isolated Paper and disclosed offline controlled native clients; no real user or independent-human qualification',
  publicTransactions:0,walletSignatures:0,paidModelCalls:0,checks:[],messages:[],fixtureShopResponses:true}
if(meta.fixtureConditions)report.fixtureConditions=meta.fixtureConditions
const clients=[],locks=[]
// The controlled unarmed fixture checks tools, not hostile combat. Internal RCON has no host port.
const rconPassword=(await readFile(join(meta.runtime,'server.properties'),'utf8')).split('\n').find(line=>line.startsWith('rcon.password='))?.slice('rcon.password='.length)
assert(rconPassword,'Recreate the owned isolation to enable its internal fixture control')
let sweeping,rconTail=Promise.resolve()
function fixtureCommands(commands){
  const work=rconTail.then(async()=>{
    const packet=(id,type,text)=>{const body=Buffer.concat([Buffer.alloc(8),Buffer.from(text),Buffer.alloc(2)]);body.writeInt32LE(id,0);body.writeInt32LE(type,4);const size=Buffer.alloc(4);size.writeInt32LE(body.length);return Buffer.concat([size,body]).toString('base64')}
    const encoded=[packet(1,3,rconPassword),...commands.map((command,i)=>packet(i+2,2,command))].join('\n')+'\n'
    await new Promise((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',meta.container,'bash','-c','exec 3<>/dev/tcp/127.0.0.1/25575; while IFS= read -r encoded; do printf "%s" "$encoded" | base64 -d >&3; sleep 0.3; done; timeout 1 cat <&3'],{timeout:12000,maxBuffer:32768},(error)=>error&&error.code!==124?reject(Error('ISOLATED_HOSTILE_CONTROL_FAILED')):resolve())
      child.stdin.end(encoded)
    })
  });rconTail=work.catch(()=>{});return work
}
function clearFixtureHostiles(){
  if(sweeping)return sweeping
  sweeping=fixtureCommands(['creeper','skeleton','spider','witch','enderman','stray','phantom'].map(type=>'execute in minecraft:agentcity_mumbai run tp @e[type=minecraft:'+type+'] 1700 -1000 2810')).finally(()=>{sweeping=null})
  return sweeping
}
report.fixtureConditions={...report.fixtureConditions,periodicHostileRemoval:true,scope:'Owned isolated tool-check copy only; hostile combat is not qualified. Live non-zombie Survival rules are unchanged.'}
const sweepTimer=setInterval(()=>{clearFixtureHostiles().catch(()=>{report.fixtureSweepFailed=true})},6000)
const check=(name,details={})=>{report.checks.push({name,status:'pass',...details});console.log('PASS '+name)}
async function bounded(promise,label,milliseconds=45000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MUMBAI_CITY_TIMEOUT_'+label)),milliseconds)})])}finally{clearTimeout(timer)}}
async function poll(read,accept,label,milliseconds=30000){const until=Date.now()+milliseconds;do{const value=await read();if(accept(value))return value;await delay(150)}while(Date.now()<until);throw Error('MUMBAI_CITY_TIMEOUT_'+label)}
async function request(path,body){const r=await fetch(`http://127.0.0.1:${meta.controlPort}/playable/`+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(15000)});return{status:r.status,value:await r.json()}}
async function native(path,body){const result=await request(path,body);if(result.status!==200)throw Error('MUMBAI_CITY_NATIVE_REFUSED_'+path.split('?')[0]+'_'+(result.value.reason||result.value.code||result.value.error||result.status));return result.value}
async function worldIds(){const {stdout}=await promisify(execFile)('python3',['-c','import json,sys; from pathlib import Path; from scripts.mumbai_city_host import mumbai; print(json.dumps(mumbai.world_ids(Path(sys.argv[1]))))',meta.runtime],{cwd:root,timeout:20000,maxBuffer:65536});return JSON.parse(stdout)}
async function connect(name){
  await delay(4500)
  const bot=mineflayer.createBot({host:'127.0.0.1',port:meta.gamePort,username:name,auth:'offline',version:'1.21.11',hideErrors:true,checkTimeoutInterval:120000})
  clients.push(bot);bot.mounts=new Map();bot.fixtureMessages=[]
  bot.on('error',error=>{report.clientError=error.message})
  bot.on('messagestr',message=>{if(!/AC_SESSION/.test(message))bot.fixtureMessages.push(message)})
  bot.on('physicsTick',()=>{if(bot._client.state==='play')bot._client.write('tick_end',{})})
  bot._client.on('set_passengers',packet=>{for(const id of packet.passengers||[])bot.mounts.set(id,packet.entityId)})
  const world=packet=>{bot.observedWorld=packet.worldState?.name||bot.observedWorld}
  bot._client.on('login',world);bot._client.on('respawn',world)
  await bounded(Promise.race([once(bot,'spawn'),once(bot,'kicked').then(([reason])=>{throw Error('MUMBAI_CITY_CLIENT_KICKED_'+JSON.stringify(reason))})]),name+'_SPAWN')
  await bounded(bot.waitForChunksToLoad(),name+'_CHUNKS')
  await clearFixtureHostiles()
  return bot
}
const inventory=bot=>bot.inventory.items().map(item=>({slot:item.slot,name:item.name,count:item.count,nbt:item.nbt||null,components:item.components?[...item.components].sort((a,b)=>String(a.type).localeCompare(String(b.type))):null})).sort((a,b)=>a.slot-b.slot)
const button=item=>item.name==='compass'&&stable(item).includes('inventory_marketplace')
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
async function session(bot){return native('session?playerId='+bot._client.uuid)}
async function reserve(actor){
  const saved=await json(join(meta.runtime,'plugins/AgentCity/discord-game-access.json'))
  const old=Object.values(saved.reservations||{}).find(value=>value.playerName===actor.name)
  await native('discord/reserve',{playerName:actor.name,principalId:actor.principalId,discordId:actor.discordId,accountKind:'local',expiresAtMs:Math.max(Date.now()+3600000,Number(old?.expiresAtMs||0))})
}
async function approve(bot,principalId){const pending=await poll(()=>session(bot),s=>s.online&&s.connectionId,'PENDING_SESSION');await native('discord/approve',{playerId:bot._client.uuid,connectionId:pending.connectionId,principalId});return poll(()=>session(bot),s=>s.pendingAuthentication===false&&s.principalId===principalId,'NATIVE_APPROVAL')}
async function window(bot,title,action){if(/^(?:Loading|Checking|Preparing|Creating|Submitting|Funding Game)/.test(title))await delay(650);const event=once(bot,'windowOpen');await action();const [opened]=await bounded(event,'WINDOW_'+title,12000);report.menuHistory||=[];report.menuHistory.push({expected:title,actual:stable(opened.title)});assert(stable(opened.title).includes(title),'Unexpected window title: expected '+title+', received '+stable(opened.title));return opened}
async function queued(bot,action){
  const current=await session(bot)
  const event=await poll(async()=>((await native('events')).events||[]).find(event=>event.playerId===bot._client.uuid&&event.connectionId===current.connectionId&&event.action==='inventory_shop'&&event.args?.[0]===action),Boolean,'SHOP_QUEUE_'+action)
  const parsed=inventoryShopEvent(event)
  report.shopWireActions||=[];report.shopWireActions.push({action,operationId:event.operationId});
  assert.equal(parsed.action,action);assert.equal(parsed.input.playerId,bot._client.uuid.toLowerCase());assert.equal(parsed.input.connectionId,current.connectionId.toLowerCase())
  return event
}
function profession(value){if(value&&typeof value==='object'){if('villagerProfession'in value&&'level'in value)return value.villagerProfession;if('profession'in value&&'level'in value)return value.profession;for(const child of Object.values(value)){const found=profession(child);if(found!==undefined)return found}}}

try {
  const status=await native('status'),properties=await native('property/status',{})
  assert.equal(status.available,true);assert.equal(status.defaultWorld,'agentcity_mumbai')
  assert.equal(status.mumbai.worldUuid,meta.worldUuid);assert.equal(status.mumbai.bank.name,'UniRock')
  assert.equal(status.mumbai.bank.templateVersion,2);assert.equal(status.mumbai.readOnly,false);assert.equal(status.mumbai.survival,true);
  const bankPath=join(meta.runtime,'plugins/AgentCity'),bankMarker=await json(join(bankPath,'unirock-bank.json')),
    bankPreviousBytes=await readFile(join(bankPath,'unirock-bank-v1.json')),bankPrevious=JSON.parse(bankPreviousBytes),bankMigration=await json(join(bankPath,'unirock-bank-migration-v1-v2.json'))
  assert.equal(bankPrevious.schema,'agentcity.unirock-bank.v1');assert.equal(bankPrevious.phase,'ready')
  assert.equal(bankMarker.schema,'agentcity.unirock-bank.v2');assert.equal(bankMarker.phase,'ready');assert.equal(bankMarker.worldUuid,meta.worldUuid)
  assert.equal(bankMigration.schema,'agentcity.unirock-bank-migration.v1-v2');assert.equal(bankMigration.phase,'ready');assert.equal(bankMigration.worldUuid,meta.worldUuid)
  assert.equal(bankMigration.previousBlueprintSha256,bankPrevious.blueprintSha256);assert.equal(bankMigration.blueprintSha256,bankMarker.blueprintSha256)
  assert.notEqual(bankPrevious.blueprintSha256,bankMarker.blueprintSha256)
  report.bankMigration={previousMarkerSha256:hash(bankPreviousBytes),previousBlueprintSha256:bankPrevious.blueprintSha256,blueprintSha256:bankMarker.blueprintSha256,phase:bankMigration.phase,worldUuid:bankMarker.worldUuid}
  check('Installed v1 bank migrated through bound intent/ready journal with archived marker and preserved world UUID',report.bankMigration)
  assert.equal(status.mumbai.bank.stockGranted,0);assert.equal(properties.serverNamespace,meta.serverId)
  assert(Number.isInteger(status.mumbai.bank.validatedBlockStates)&&status.mumbai.bank.validatedBlockStates>=20,'Actual Paper did not validate every template descriptor')
  assert.deepEqual(await worldIds(),meta.sourceWorldIds)
  const oldState=await json(join(meta.runtime,'plugins/AgentCity/playable-state.json'))
  const {x:px,y:py,z:pz}=oldState.playSpawn
  assert.equal(status.personalAgentCapacity,5);assert.equal(status.taskRegions.length,5)
  for(let i=0;i<3;i++){
    const region=status.taskRegions.find(r=>r.slotName==='CityAgent'+(i+1)),x=px+(i===2?23:i===1?-31:20),z=pz+(i===2?18:-6)
    assert.equal(region.worldName,'agentcity_play');assert.deepEqual(region.min,{x,y:py,z})
    assert.deepEqual(region.max,{x:x+11,y:py+7,z:z+11});assert.deepEqual(region.sourceChest,[x,py,z]);assert.deepEqual(region.destinationChest,[x,py,z+2])
  }
  for(let i=0;i<2;i++){const region=status.taskRegions.find(r=>r.slotName==='CityAgent'+(i+4));assert.equal(region.worldName,'agentcity_mumbai');assert.deepEqual(region.min,{x:1730+i*16,y:69,z:2810})}
  const retained={}
  for(const file of ['personal-agents.json','personal-agent-tasks.json'])retained[file]=hash(await readFile(join(meta.runtime,file)))
  check('Actual Paper parses the template block states; seven world identities, economic namespace and three legacy task regions are preserved with separate new Mumbai slots',{nativeValidatedBlockStates:status.mumbai.bank.validatedBlockStates})

  const fixtureHex=hash('unirock-native-fixture:'+meta.id+':'+runId).slice(0,32)
  const actor={name:'UniRock'+runId.slice(0,6),principalId:[fixtureHex.slice(0,8),fixtureHex.slice(8,12),fixtureHex.slice(12,16),fixtureHex.slice(16,20),fixtureHex.slice(20)].join('-'),
    discordId:String(780000000000000000n+BigInt('0x'+fixtureHex.slice(0,12)))}
  await reserve(actor)
  let visitor=await connect(actor.name)
  const pending=await poll(()=>session(visitor),s=>s.online&&s.pendingAuthentication===true,'VISITOR_GATE')
  assert.equal(pending.serverPosition.world,'agentcity_mumbai')
  const before=inventory(visitor),anchor=pending.pendingPosition
  visitor.setControlState('forward',true);await delay(1000);visitor.clearControlStates();await delay(350)
  const frozen=await session(visitor)
  assert(distance(frozen.serverPosition,anchor)<0.02,'Unapproved native player moved from held anchor')
  const eventsBefore=(await native('events')).events.filter(event=>event.playerId===visitor._client.uuid).length
  visitor.chat('/agent status');await delay(700)
  assert.equal((await native('events')).events.filter(event=>event.playerId===visitor._client.uuid).length,eventsBefore)
  assert.deepEqual(inventory(visitor),before)
  check('Unapproved visitor remains frozen in the Mumbai arrival gate without an agent request or inventory change')
  const approved=await approve(visitor,actor.principalId)
  const arrivalTarget=approved.serverPosition
  assert.equal(approved.serverPosition.world,'agentcity_mumbai');assert.equal(approved.serverGameMode,'SURVIVAL')
  await poll(()=>inventory(visitor),items=>items.filter(button).length===1,'ONE_TAGGED_MARKETPLACE_BUTTON')
  await poll(()=>visitor.entity.position,p=>distance(p,arrivalTarget)<0.2,'CLIENT_APPROVED_ARRIVAL')
  await bounded(visitor.waitForChunksToLoad(),'APPROVED_CHUNKS')
  const after=inventory(visitor)
  assert.deepEqual(after.filter(item=>!button(item)),before.filter(item=>!button(item)))
  assert.equal(after.filter(button).length,1)
  const arrival=visitor.entity.position.clone(),floor=visitor.blockAt(arrival.offset(0,-0.05,0).floored())
  report.arrivalDiagnostic={native:approved.serverPosition,client:arrival,floor:floor?{name:floor.name,boundingBox:floor.boundingBox,position:floor.position}:null}
  assert(floor&&floor.boundingBox==='block');assert(arrival.x>1692.5&&arrival.x-1692.5<10)
  check('Approved visitor defaults to UniRock on a solid floor right of the agent concierge pads; existing items survive and one tagged shop compass is present',{arrival:approved.serverPosition,buttonAddedThisRun:before.filter(button).length===0})

  const bots={},bankHomes={}
  for(const [name,x]of [['CityAgent4',1687.5],['CityAgent5',1692.5]]){
    await delay(1000);const bot=await connect(name);bots[name]=bot
    await poll(()=>bot.entity.position,p=>distance(p,{x,y:69,z:2812.5})<=8.2&&Math.abs(p.y-69)<0.15,name+'_BANK_HOME')
    bankHomes[name]=bot.entity.position.clone()
    assert.equal(bot.game.gameMode,'survival');assert(bot.blockAt(bot.entity.position.offset(0,-0.05,0).floored())?.boundingBox==='block')
    report.agentArrivalInventories||={};report.agentArrivalInventories[name]=inventory(bot)
    const health=bot.health;await fixtureCommands(['damage '+name+' 4 minecraft:generic']);await delay(250);assert.equal(bot.health,health,'Bank service bot must survive damage at its concierge pad')
  }
  check('Both new native agent clients idle in Survival at the safe Mumbai bank pads; no model call or inventory effect occurs')
  for(const name of Object.keys(bots)){
    const taskId=randomUUID(),payload={slotName:name,taskId,ownerId:actor.principalId,ownerPlayerId:visitor._client.uuid}
    locks.push(payload);await native('task-lock',{...payload,locked:true})
    const region=status.taskRegions.find(r=>r.slotName===name),bot=bots[name]
    await poll(()=>bot.entity.position,p=>distance(p,{x:region.min.x+1.5,y:69,z:2811.5})<0.2,name+'_WORK_HOME')
    const beforeDamage=bot.health;await fixtureCommands(['damage '+name+' 4 minecraft:generic']);await delay(250);assert(bot.health<beforeDamage,'Outside the bank the agent must retain normal Survival damage')
    await native('task-lock',{...payload,locked:false});locks.splice(locks.indexOf(payload),1)
    await poll(()=>bot.entity.position,p=>distance(p,bankHomes[name])<0.2,name+'_RETURN_BANK')
    report.agentAfterWalkInventories||={};report.agentAfterWalkInventories[name]=inventory(bot)
  }
  check('Each task lock teleports only its named new agent to its assigned Mumbai work area and unlock returns it to the bank without items or block effects')
  check('Service bots are protected at bank concierge pads but take real Survival damage in their outdoor work areas')

  visitor.loadPlugin(pathfinder);const movement=new Movements(visitor);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false
  visitor.pathfinder.setMovements(movement)
  const emptyHand=Array.from({length:9},(_,i)=>i).find(i=>!visitor.inventory.slots[36+i])
  assert.notEqual(emptyHand,undefined);visitor.setQuickBarSlot(emptyHand);await delay(250)
  visitor.on('path_update',value=>{report.lastNavigation={status:value.status,pathLength:value.path?.length,cost:value.cost,position:visitor.entity.position.clone()}})
  async function walk(x,z,label){
    visitor.pathfinder.setGoal(new goals.GoalBlock(x,69,z))
    try{await poll(()=>visitor.entity.position,p=>distance(p,{x:x+0.5,y:69,z:z+0.5})<0.9,label,30000)}
    catch(error){report.failedNavigation={target:{x,y:69,z},client:visitor.entity.position.clone(),server:(await session(visitor)).serverPosition,held:visitor.heldItem?.name||null};throw error}
    visitor.pathfinder.setGoal(null)
  }
  for(const [x,z]of [[1721,2815],[1725,2815],[1725,2809],[1730,2809]])await walk(x,z,'PUBLIC_ROUTE_'+x+'_'+z)
  visitor.pathfinder.setGoal(null);await delay(250)
  const stockChest=visitor.blockAt(new visitor.entity.position.constructor(1730,69,2810))
  assert.equal(stockChest?.name,'chest')
  let source
  try{source=await visitor.openContainer(stockChest)}catch(error){report.chestDiagnostic={held:visitor.heldItem?.name,position:visitor.entity.position.clone(),above:visitor.blockAt(stockChest.position.offset(0,1,0))?.name,window:visitor.currentWindow?.title,messages:visitor.fixtureMessages.slice(-8)};throw error}
  source.close();assert.deepEqual(inventory(visitor),after)
  check('Any approved Survival player can open city containers without belonging to a plot group')
  const skillReceipts=[]
  const skills=new SurvivalTools({rootDirectory:root,manager:{taskRegions:status.taskRegions},slot:{name:'CityAgent4',bot:visitor},world:status,
    guard:async()=>{assert.equal((await session(visitor)).pendingAuthentication,false)},beforeEffect:async d=>{report.pendingSurvivalEffect=d},receipt:async r=>{skillReceipts.push(r);report.pendingSurvivalEffect=null;report.survivalReceipts=skillReceipts}})
  await skills.execute({tool:'withdraw',item:'oak_planks',count:8,position:[1730,69,2810]})
  await skills.execute({tool:'withdraw',item:'cobblestone',count:1,position:[1730,69,2810]})
  assert.equal((await skills.execute({tool:'craft',item:'stick',count:4})).produced,4)
  assert.equal((await skills.execute({tool:'craft',item:'lever',count:1})).produced,1)
  const wallZ=[2815,2816,2817,2818,2819,2820].find(z=>[1734,1735,1736].every(x=>visitor.blockAt(new skills.Vec3(x,68,z))?.boundingBox==='block'&&[69,70].every(y=>['air','cave_air'].includes(visitor.blockAt(new skills.Vec3(x,y,z))?.name))))
  assert.notEqual(wallZ,undefined,'A fresh physical construction footprint is required; existing work must not be overwritten')
  const house=await skills.execute({tool:'build',structure:'wall',width:3,depth:1,height:2,item:'oak_planks',position:[1734,69,wallZ]})
  assert.equal(house.verifiedBlocks,6)
  await skills.execute({tool:'place',item:'lever',position:[1725,69,2814]})
  const activated=await skills.execute({tool:'activate',position:[1725,69,2814]})
  assert.equal(activated.properties.powered,true)
  const lever=visitor.blockAt(new visitor.entity.position.constructor(1725,69,2814))
  await visitor.dig(lever,true);await skills.move([1725,69,2814],0)
  await poll(()=>visitor.inventory.items().find(i=>i.name==='lever'),Boolean,'SURVIVAL_LEVER_PICKUP')
  await skills.execute({tool:'deposit',item:'lever',count:1,position:[1730,69,2810]})
  await skills.execute({tool:'deposit',item:'stick',count:3,position:[1730,69,2810]})
  assert.deepEqual(inventory(visitor),after)
  check('Actual Survival tools withdraw finite supplies, craft sticks and lever, build a verified six-block wall and toggle real redstone power',{actor:'isolated approved native player, not agent authority qualification',house,verifiedToolReceipts:skillReceipts.length})

  const npcs=()=>Object.values(visitor.entities).filter(entity=>entity.name==='villager')
  const roles=['Guide','Agent Desk','Job Board','Wallet & Market','Play']
  const named=await poll(npcs,values=>roles.every(role=>values.some(entity=>stable(entity.metadata).includes(role))),'FIVE_BANK_NPCS')
  const people=roles.map(role=>named.find(entity=>stable(entity.metadata).includes(role)))
  assert.equal(new Set(people.map(entity=>entity.id)).size,5)
  assert(people.every(entity=>entity.position.x>=1660&&entity.position.x<=1722&&entity.position.z>=2800&&entity.position.z<=2854))
  await poll(()=>people.every(entity=>visitor.mounts.has(entity.id)),Boolean,'SEATED_NPC_PASSENGERS')
  const professions=people.map(entity=>profession(entity.metadata))
  assert(professions.every(value=>value!==undefined),'Villager profession metadata was not observed')
  assert.equal(new Set(professions).size,5)
  for(let i=0;i<people.length;i++){
    const npc=people[i]
    visitor.pathfinder.setGoal(new goals.GoalBlock(Math.floor(npc.position.x),69,2845))
    await poll(()=>visitor.entity.position,p=>Math.abs(p.x-npc.position.x)<0.8&&Math.abs(p.z-2845.5)<0.8,'WALK_TO_'+roles[i],45000)
    visitor.pathfinder.setGoal(null);await delay(250)
    await window(visitor,roles[i],()=>visitor.activateEntityAt(npc,npc.position.offset(0,1.4,0)))
    visitor.closeWindow(visitor.currentWindow);await delay(250)
  }
  assert.deepEqual(inventory(visitor),after)
  const Vec=visitor.entity.position.constructor
  assert.equal(visitor.blockAt(new Vec(1660,69,2800))?.name,'smooth_quartz')
  const glyphs=[['10001','10001','10001','10001','10001','10001','01110'],['10001','11001','11001','10101','10011','10011','10001'],['11111','00100','00100','00100','00100','00100','11111'],['11110','10001','10001','11110','10100','10010','10001'],['01110','10001','10001','10001','10001','10001','01110'],['01111','10000','10000','10000','10000','10000','01111'],['10001','10010','10100','11000','10100','10010','10001']]
  for(let i=0;i<glyphs.length;i++)for(let row=0;row<7;row++)for(let col=0;col<5;col++)assert.equal(visitor.blockAt(new Vec(1712-i*6-col-(i>=3?2:0),93-row,2799))?.name,glyphs[i][row][col]==='1'?'gold_block':'air','UNIROCK must read normally from outside north')
  for(const x of [1669,1680,1691,1702,1713])for(let z=2843;z<=2845;z++)for(let y=69;y<=70;y++)assert.equal(visitor.blockAt(new Vec(x,y,z))?.name,'air','NPC walk-up must remain clear')
  check('UniRock has its actual quartz and gold facade and five distinct seated professional NPCs; each real service menu opens without taking menu items',{roles,professions,seated:5})

  const baseInventory=stable(inventory(visitor))
  const marketButton=visitor.inventory.items().find(button)
  assert(marketButton)
  await window(visitor,'Loading Materials',()=>visitor.clickWindow(marketButton.slot,0,0))
  const catalogEvent=await queued(visitor,'catalog')
  const catalog={entries:[{item:'oak_planks',available:64,unitPriceCity:'0.125'},{item:'stone',available:64,unitPriceCity:'0.25'}],paymentReady:false}
  const assertProgress=()=>{
    assert.equal(visitor.currentWindow.slots.length>=54,true)
    for(const [slot,label] of [[10,'1. Choose Item'],[12,'2. Quantity'],[14,'3. Review'],[16,'4. Checkout']])assert(stable(visitor.currentWindow.slots[slot]).includes(label))
  }
  const quote=count=>({item:'oak_planks',count,unitPriceCity:'0.125',totalCity:String(count*0.125),paymentReady:true,quoteId:randomUUID(),expiresAtMs:Date.now()+60000})
  await window(visitor,'Choose Item',()=>native('inventory-shop/reply',{operationId:catalogEvent.operationId,result:catalog}));assertProgress()
  await window(visitor,'Choose Quantity',()=>visitor.clickWindow(19,0,0));assertProgress()
  for(let i=0;i<3;i++)await window(visitor,'Choose Quantity',()=>visitor.clickWindow(33,0,0))
  assert.equal(visitor.currentWindow.slots[22].count,4)
  assert(stable(visitor.currentWindow.slots[31]).includes('0.5 CITY'))
  await delay(650);await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const quoteEvent=await queued(visitor,'quote'),fields=JSON.parse(quoteEvent.args[1])
  assert.deepEqual(fields,{item:'oak_planks',count:4})
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:quoteEvent.operationId,result:{...quote(4),paymentReady:false}}));assertProgress()
  assert.equal(visitor.currentWindow.slots[49].name,'gray_concrete')
  await visitor.clickWindow(49,0,0);await delay(650)
  assert.equal((await native('events')).events.filter(e=>e.playerId===visitor._client.uuid&&e.action==='inventory_shop'&&e.args[0]==='checkout').length,0)
  await window(visitor,'Choose Quantity',()=>visitor.clickWindow(45,0,0));assert.equal(visitor.currentWindow.slots[22].count,4)
  await delay(650);await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const expiringEvent=await queued(visitor,'quote')
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:expiringEvent.operationId,result:{...quote(4),expiresAtMs:Date.now()+3000}}))
  await delay(650);await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const refreshEvent=await queued(visitor,'quote');assert.deepEqual(JSON.parse(refreshEvent.args[1]),{item:'oak_planks',count:4})
  const currentQuote=quote(4)
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:refreshEvent.operationId,result:currentQuote}))
  await delay(650);await window(visitor,'Preparing Checkout',()=>visitor.clickWindow(49,0,0))
  const expiredCheckout=await queued(visitor,'checkout');assert.deepEqual(JSON.parse(expiredCheckout.args[1]),{quoteId:currentQuote.quoteId})
  await window(visitor,'Review Expired',()=>native('inventory-shop/reply',{operationId:expiredCheckout.operationId,result:{error:'FRESH_QUOTE_REQUIRED',message:'Labelled isolated expiry fixture; no wallet or payment request.'}}))
  await delay(650);await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const retryEvent=await queued(visitor,'quote');assert.deepEqual(JSON.parse(retryEvent.args[1]),{item:'oak_planks',count:4})
  const finalQuote=quote(4)
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:retryEvent.operationId,result:finalQuote}))
  await delay(650);await window(visitor,'Preparing Checkout',()=>visitor.clickWindow(49,0,0))
  const checkoutEvent=await queued(visitor,'checkout');assert.deepEqual(JSON.parse(checkoutEvent.args[1]),{quoteId:finalQuote.quoteId})
  const gameOrder={mode:'privy_game',orderId:randomUUID(),quoteId:finalQuote.quoteId,consentNonce:'A'.repeat(43),item:'oak_planks',count:4,totalCity:'0.5',totalBaseUnits:'500000000000000000',chainId:1301,maxNativeFeeWei:'9000000000000',maxNativeFeeEth:'0.000009',status:'wallet_required',paid:false,paymentConsentRecorded:false,fundingAvailable:false}
  await window(visitor,'Review Expired',()=>native('inventory-shop/reply',{operationId:checkoutEvent.operationId,result:{...gameOrder,status:'expired'}}))
  assert(stable(visitor.currentWindow.slots[49]).includes('Refresh Review'))
  await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const renewedQuoteEvent=await queued(visitor,'quote'),renewedQuote=quote(4)
  assert.deepEqual(JSON.parse(renewedQuoteEvent.args[1]),{item:'oak_planks',count:4})
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:renewedQuoteEvent.operationId,result:renewedQuote}))
  await window(visitor,'Preparing Checkout',()=>visitor.clickWindow(49,0,0))
  const renewedCheckout=await queued(visitor,'checkout');Object.assign(gameOrder,{orderId:randomUUID(),quoteId:renewedQuote.quoteId})
  await window(visitor,'Create Game Wallet',()=>native('inventory-shop/reply',{operationId:renewedCheckout.operationId,result:gameOrder}));assertProgress()
  assert(stable(visitor.currentWindow.slots[40]).includes('AgentCity-managed'))
  assert(stable(visitor.currentWindow.slots[40]).includes('not your existing MetaMask'))
  assert.equal(report.shopWireActions.filter(event=>event.action==='confirm').length,0)
  await window(visitor,'Creating Game Wallet',()=>visitor.clickWindow(49,0,0))
  const enrollEvent=await queued(visitor,'enroll');assert.deepEqual(JSON.parse(enrollEvent.args[1]),{orderId:gameOrder.orderId})
  const provisionedOrder={...gameOrder,status:'insufficient_funds',walletAddress:'0x1111111111111111111111111111111111111111',cityBalance:'0',nativeBalanceWei:'0',fundingAvailable:true}
  await window(visitor,'Add CITY to Game Wallet',()=>native('inventory-shop/reply',{operationId:enrollEvent.operationId,result:provisionedOrder}));assertProgress()
  assert(stable(visitor.currentWindow.slots[43]).includes('Get 1 test CITY + 0.0001 test ETH'))
assert.equal(visitor.currentWindow.slots[39].name,'paper')
assert(stable(visitor.currentWindow.slots[39]).includes('not a button'))
  assert.equal(report.shopWireActions.filter(event=>event.action==='confirm').length,0)
async function rejectShopDuringCooldown(slot){
  await delay(650)
  const before=new Set(((await native('events')).events||[]).map(event=>event.operationId))
  visitor.chat('/agent claude status')
  await poll(async()=>((await native('events')).events||[]).find(event=>event.playerId===visitor._client.uuid&&event.action==='agent'&&!before.has(event.operationId)),Boolean,'COOLDOWN_FIXTURE_EVENT')
  await window(visitor,'Check Purchase',()=>visitor.clickWindow(slot,0,0))
  assert(stable(visitor.currentWindow.slots[31]).includes('Your request was not queued'))
}
await rejectShopDuringCooldown(43)
await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
const rejectedFundingStatus=await queued(visitor,'status')
await window(visitor,'Add CITY to Game Wallet',()=>native('inventory-shop/reply',{operationId:rejectedFundingStatus.operationId,result:provisionedOrder}))
assert(stable(visitor.currentWindow.slots[43]).includes('Get 1 test CITY + 0.0001 test ETH'),'Known queue rejection must allow a fresh explicit funding click')
  await window(visitor,'Funding Game Wallet',()=>visitor.clickWindow(43,0,0))
  const fundEvent=await queued(visitor,'fund');assert.deepEqual(JSON.parse(fundEvent.args[1]),{orderId:gameOrder.orderId,consentNonce:gameOrder.consentNonce})
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:fundEvent.operationId,result:{error:'REQUEST_TIMEOUT',message:'Labelled ambiguous-grant fixture; no actual wallet or funding call.'}}))
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const fundingStatus=await queued(visitor,'status');assert.deepEqual(JSON.parse(fundingStatus.args[1]),{orderId:gameOrder.orderId})
  const readyOrder={...provisionedOrder,status:'ready',cityBalance:'1',nativeBalanceWei:'100000000000000',fundingAvailable:false,consentNonce:'B'.repeat(43),paymentConsentRecorded:false,starterGrantConfirmed:true}
  await window(visitor,'Funding Pending',()=>native('inventory-shop/reply',{operationId:fundingStatus.operationId,result:{...provisionedOrder,status:'funding_pending',cityBalance:'1',nativeBalanceWei:'100000000000000',fundingAvailable:false,starterGrant:{status:'pending'}}}))
  assert(stable(visitor.currentWindow.slots[49]).includes('Check purchase'),'An apparent funded balance must not enable Pay before canonical grant completion')
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const fundingSettledStatus=await queued(visitor,'status')
  await window(visitor,'Confirm Purchase',()=>native('inventory-shop/reply',{operationId:fundingSettledStatus.operationId,result:readyOrder}));assertProgress()
  assert.equal(visitor.currentWindow.slots[22].count,4)
  assert(stable(visitor.currentWindow.slots[31]).includes('0.5 CITY'))
  assert(stable(visitor.currentWindow.slots[40]).includes(readyOrder.walletAddress))
  assert(stable(visitor.currentWindow.slots[40]).includes('0.000009 test ETH'))
  assert(stable(visitor.currentWindow.slots[49]).includes('Pay 0.5 CITY'))
  await window(visitor,'How Shopping Works',()=>visitor.clickWindow(47,0,0))
  assert(stable(visitor.currentWindow.slots[31]).includes('Pay button'));assert(!stable(visitor.currentWindow.slots[31]).includes('browser'))
  await window(visitor,'Confirm Purchase',()=>visitor.clickWindow(45,0,0))
  assert.equal(report.shopWireActions.filter(event=>event.action==='confirm').length,0)
await rejectShopDuringCooldown(49)
await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
const rejectedPaymentStatus=await queued(visitor,'status')
await window(visitor,'Confirm Purchase',()=>native('inventory-shop/reply',{operationId:rejectedPaymentStatus.operationId,result:readyOrder}))
assert(stable(visitor.currentWindow.slots[49]).includes('Pay 0.5 CITY'),'Known queue rejection must allow a fresh explicit payment click')
  await window(visitor,'Submitting Purchase',()=>visitor.clickWindow(49,0,0))
  const confirmEvent=await queued(visitor,'confirm');assert.deepEqual(JSON.parse(confirmEvent.args[1]),{orderId:gameOrder.orderId,consentNonce:readyOrder.consentNonce})
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:confirmEvent.operationId,result:{error:'REQUEST_TIMEOUT',message:'Labelled ambiguous-payment fixture; no real wallet was invoked.'}}))
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const missingFunds=await queued(visitor,'status');assert.deepEqual(JSON.parse(missingFunds.args[1]),{orderId:gameOrder.orderId})
  await window(visitor,'Add CITY to Game Wallet',()=>native('inventory-shop/reply',{operationId:missingFunds.operationId,result:{...readyOrder,status:'insufficient_funds',cityBalance:'0.1'}}))
  assert(stable(visitor.currentWindow.slots[40]).includes(readyOrder.walletAddress));assert(stable(visitor.currentWindow.slots[39]).includes('0.1'))
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const readyAgain=await queued(visitor,'status')
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:readyAgain.operationId,result:readyOrder}))
  assert(stable(visitor.currentWindow.slots[49]).includes('Check purchase'),'A prior confirmation must not become another Pay button')
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const pendingOrder=await queued(visitor,'status')
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:pendingOrder.operationId,result:{...readyOrder,status:'pending',paid:true}}))
  const oldConnection=(await session(visitor)).connectionId,ended=once(visitor,'end');visitor.quit('Isolated purchase recovery check');await bounded(ended,'VISITOR_RECONNECT',8000)
  visitor=await connect(actor.name);const resumedSession=await approve(visitor,actor.principalId);assert.notEqual(resumedSession.connectionId,oldConnection)
  await poll(()=>inventory(visitor),items=>items.filter(button).length===1,'RECOVERED_TAGGED_BUTTON')
  await window(visitor,'Loading Materials',()=>visitor.clickWindow(visitor.inventory.items().find(button).slot,0,0))
  const resumeCatalog=await queued(visitor,'catalog'),activeOrder={...readyOrder,status:'pending',paid:true,paymentConsentRecorded:true,unitPriceCity:'0.125',expiresAtMs:Date.now()+60000}
  await window(visitor,'Choose Item',()=>native('inventory-shop/reply',{operationId:resumeCatalog.operationId,result:{...catalog,paymentReady:true,activeOrder}}))
  assert(stable(visitor.currentWindow.slots[40]).includes('Resume My Purchase'))
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(40,0,0))
  const resumeStatus=await queued(visitor,'status');assert.deepEqual(JSON.parse(resumeStatus.args[1]),{orderId:gameOrder.orderId})
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:resumeStatus.operationId,result:{error:'REQUEST_TIMEOUT',message:'Labelled resumed-order status failure; no wallet or payment call.'}}))
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const resumedRetry=await queued(visitor,'status');assert.deepEqual(JSON.parse(resumedRetry.args[1]),{orderId:gameOrder.orderId})
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:resumedRetry.operationId,result:activeOrder}))
  assert(!stable(visitor.currentWindow.slots[49]).includes('Pay 0.5 CITY'));assert.equal(report.shopWireActions.filter(event=>event.action==='confirm').length,1)
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const unconfirmedDelivery=await queued(visitor,'status')
  await window(visitor,'Check Purchase',()=>native('inventory-shop/reply',{operationId:unconfirmedDelivery.operationId,result:{...readyOrder,status:'delivered',paid:true}}))
  assert(!stable(visitor.currentWindow.slots[40]).includes('Purchase Delivered'),'Payment/status label alone must not claim native delivery')
  await window(visitor,'Checking Purchase',()=>visitor.clickWindow(49,0,0))
  const collectionReady=await queued(visitor,'status')
  await window(visitor,'Collect Materials',()=>native('inventory-shop/reply',{operationId:collectionReady.operationId,result:{...readyOrder,status:'ready_to_collect',paid:true,deliveryConfirmed:false}}))
  await delay(650);await visitor.clickWindow(49,0,0)
  await poll(()=>visitor.currentWindow,value=>value===null,'COLLECTION_LEAVES_NATIVE_INVENTORY_CLOSED')
  const deliveredOrder=await queued(visitor,'status');assert.deepEqual(JSON.parse(deliveredOrder.args[1]),{orderId:gameOrder.orderId})
  assert.equal(visitor.currentWindow,null,'No loading shop may block canonical native inventory delivery')
  await window(visitor,'Purchase Complete',()=>native('inventory-shop/reply',{operationId:deliveredOrder.operationId,result:{...readyOrder,status:'delivered',paid:true,deliveryConfirmed:true}}));assertProgress()
  assert(stable(visitor.currentWindow.slots[40]).includes('Purchase Delivered'))
  assert.equal(report.shopWireActions.filter(event=>event.action==='confirm').length,1)
  assert.equal(report.shopWireActions.filter(event=>event.action==='fund').length,1)
  visitor.closeWindow(visitor.currentWindow)
  assert.equal(stable(inventory(visitor)),baseInventory)
  check('Native inventory shop completes Privy wallet disclosure, explicit enrollment, exact-price consent, same-order recovery after an actual reconnect and guarded delivery receipt without browser navigation',{source:'Labelled isolated GUI fixtures only; no actual wallet enrollment, token payment or resource delivery',selectedCount:4,displayedTotalCity:'0.5',confirmationRequests:1,starterGrantRequests:1,statusRecovery:'Same order after ambiguous confirmation, insufficient funds and pending delivery; no repeat confirmation',delivery:'Receipt fixture requires paid and canonical deliveryConfirmed; actual inventory remains unchanged'})

  await window(visitor,'Loading Materials',()=>visitor.chat('/market'))
  const autoCollectionCatalog=await queued(visitor,'catalog')
  await window(visitor,'Collect Materials',()=>native('inventory-shop/reply',{operationId:autoCollectionCatalog.operationId,result:{...catalog,paymentReady:true,activeOrder:{...readyOrder,unitPriceCity:'0.125',status:'ready_to_collect',paid:true,paymentConsentRecorded:true}}}))
  assert(stable(visitor.currentWindow.slots[49]).includes('Collect'),'A paid mailbox must open collection directly instead of another shopping screen')
  visitor.closeWindow(visitor.currentWindow)
  visitor.chat('/lobby');await poll(()=>session(visitor),s=>s.serverPosition.world==='agentcity_mumbai'&&distance(s.serverPosition,arrivalTarget)<0.2,'LOBBY_DEFAULT_MUMBAI')
  await delay(650);visitor.chat('/museum');await poll(()=>session(visitor),s=>s.serverPosition.world===status.museumWorld,'PRESERVED_MUSEUM')
  await delay(650);visitor.chat('/play');await poll(()=>session(visitor),s=>s.serverPosition.world==='agentcity_mumbai'&&s.serverGameMode==='SURVIVAL','PLAY_DEFAULT_MUMBAI')
  await poll(()=>visitor.entity.position,p=>distance(p,arrivalTarget)<0.2,'CLIENT_RETURN_TO_MUMBAI')
  await bounded(visitor.waitForChunksToLoad(),'RETURN_CHUNKS')
  assert.equal(stable(inventory(visitor)),baseInventory)
  const solid=visitor.blockAt(visitor.entity.position.offset(0,-0.05,0).floored()),oldBlock=solid.stateId
  const digMilliseconds=visitor.digTime(solid)
  assert(Number.isFinite(digMilliseconds)&&digMilliseconds>0&&digMilliseconds<=30000)
  await visitor.dig(solid,true)
  await poll(()=>bots.CityAgent4.blockAt(solid.position)?.name,name=>name==='air','SURVIVAL_CITY_BLOCK_BROKEN')
  assert.notEqual(bots.CityAgent4.blockAt(solid.position)?.stateId,oldBlock)
  assert.equal(stable(inventory(visitor)),baseInventory)
  await delay(650);visitor.chat('/museum');await poll(()=>session(visitor),s=>s.serverPosition.world===status.museumWorld,'SURVIVAL_MUSEUM_RETURN')
  await delay(650);visitor.chat('/play');await poll(()=>session(visitor),s=>s.serverPosition.world==='agentcity_mumbai','SURVIVAL_CITY_RETURN')
  await bounded(visitor.waitForChunksToLoad(),'SURVIVAL_FRESH_CHUNKS')
  assert.equal(visitor.blockAt(solid.position)?.name,'air','Mining persists in fresh native chunks')
  check('Mumbai is editable Survival: real city mining persists, while museum access and inventory custody remain intact',{attemptedDigMilliseconds:digMilliseconds,readOnly:status.mumbai.readOnly})

  const roster=await json(join(meta.runtime,'laptop-fixture-actors.json')),seller=roster.actors.find(a=>a.name==='BankSeller')
  assert(seller,'Copied controlled seller is required for the finite merchant-stock check')
  await reserve(seller);await delay(1000)
  const merchant=await connect(seller.name),merchantPendingInventory=inventory(merchant),merchantSession=await approve(merchant,seller.principalId)
  await delay(500)
  const beforeStock=inventory(merchant),stockInput={sellerId:seller.principalId,sellerAccountId:merchant._client.uuid,ownerPlayerId:merchant._client.uuid,sourceId:merchant._client.uuid,connectionId:merchantSession.connectionId}
  assert.deepEqual(beforeStock.filter(item=>!button(item)),merchantPendingInventory.filter(item=>!button(item)),'Existing merchant equipment changed while adding the shop button')
  const plainRead=await native('escrow/shop-stock',stockInput)
  assert.deepEqual(inventory(merchant),beforeStock)
  const stocked=await native('escrow/shop-stock',{...stockInput,bootstrap:true,operationId:randomUUID()})
  if(plainRead.demoStockGranted!==true)await poll(()=>inventory(merchant),items=>Object.keys(stocked.items).every(name=>items.filter(item=>item.name===name).reduce((sum,item)=>sum+item.count,0)>=64),'FINITE_MERCHANT_STOCK')
  else {await delay(300);assert.deepEqual(inventory(merchant),beforeStock,'Repeated bootstrap must not refill legitimately spent finite stock')}
  const afterStock=inventory(merchant)
  for(const item of beforeStock.filter(item=>!Object.hasOwn(stocked.items,item.name)))assert(afterStock.some(value=>stable(value)===stable(item)),'Existing non-catalog item changed')
  assert.equal(Object.keys(inventoryShopPrices).length,8);assert(Object.keys(stocked.items).every(item=>Object.hasOwn(inventoryShopPrices,item)));assert.equal(stocked.demoStockGranted,true)
  if(!plainRead.demoStockGranted)assert.equal(Object.keys(stocked.items).length,8)
  assert(Object.values(stocked.items).every(count=>Number.isInteger(count)&&count>=0&&count<=36*64),'Finite stock may legitimately be depleted; counts must still fit the real inventory')
  for(const name of Object.keys(stocked.items)){
    const total=items=>items.filter(item=>item.name===name).reduce((sum,item)=>sum+item.count,0)
    assert.equal(total(afterStock)-total(beforeStock),plainRead.demoStockGranted?0:64,'Finite resource grant must add exactly64 once')
  }
  const repeated=await native('escrow/shop-stock',{...stockInput,bootstrap:true,operationId:randomUUID()})
  await delay(350)
  assert.equal(repeated.fingerprint,stocked.fingerprint);assert.deepEqual(inventory(merchant),afterStock)
  check('Copied BankSeller receives finite operator demo stock once; reads and repeated bootstrap preserve inventory and existing non-catalog equipment',{initialResources:8,initialUnitsPerResource:64,availableResources:Object.keys(stocked.items).length,alreadyGrantedBeforeThisRun:plainRead.demoStockGranted===true,provenance:stocked.provenance})

  // Bounded native collection guard check; no asset mint, release, payment or physical claim is simulated.
  const merchantBeforePreview=stable(inventory(merchant)),buyerBeforePreview=stable(inventory(visitor)),merchantStack=merchant.inventory.items().find(item=>Object.hasOwn(stocked.items,item.name)&&item.count>=2)
  assert(merchantStack)
  const merchantPreview=await native('escrow/preview',{operationId:randomUUID(),sellerId:seller.principalId,sellerAccountId:merchant._client.uuid,ownerPlayerId:merchant._client.uuid,sourceId:merchant._client.uuid,sourceKind:'player_inventory',connectionId:merchantSession.connectionId,slot:merchantStack.slot>=36?merchantStack.slot-36:merchantStack.slot,count:2})
  assert.equal(merchantPreview.item,'minecraft:'+merchantStack.name);assert.equal(merchantPreview.count,2)
  assert.equal(stable(inventory(merchant)),merchantBeforePreview,'Custody preview must not take or grant stock')
  await window(visitor,'Loading Materials',()=>visitor.clickWindow(visitor.inventory.items().find(button).slot,0,0))
  const collectionCatalog=await queued(visitor,'catalog')
  await window(visitor,'Choose Item',()=>native('inventory-shop/reply',{operationId:collectionCatalog.operationId,result:{...catalog,paymentReady:true}}))
  await window(visitor,'Choose Quantity',()=>visitor.clickWindow(19,0,0))
  await window(visitor,'Choose Quantity',()=>visitor.clickWindow(33,0,0))
  await window(visitor,'Checking Your Order',()=>visitor.clickWindow(49,0,0))
  const collectionQuoteEvent=await queued(visitor,'quote'),collectionQuote=quote(2)
  await window(visitor,'Review Order',()=>native('inventory-shop/reply',{operationId:collectionQuoteEvent.operationId,result:collectionQuote}))
  await window(visitor,'Preparing Checkout',()=>visitor.clickWindow(49,0,0))
  const collectionCheckout=await queued(visitor,'checkout'),collectionOrder={...readyOrder,quoteId:collectionQuote.quoteId,orderId:randomUUID(),consentNonce:'C'.repeat(43),count:2,totalCity:'0.25',totalBaseUnits:'250000000000000000',status:'ready_to_collect',paid:true,paymentConsentRecorded:true,deliveryConfirmed:false}
  await window(visitor,'Collect Materials',()=>native('inventory-shop/reply',{operationId:collectionCheckout.operationId,result:collectionOrder}))
  const currentBuyer=await session(visitor),buyerPreview={operationId:randomUUID(),sellerId:actor.principalId,sellerAccountId:visitor._client.uuid,ownerPlayerId:visitor._client.uuid,sourceId:visitor._client.uuid,sourceKind:'player_inventory',connectionId:currentBuyer.connectionId,slot:0,count:1}
  await assert.rejects(native('escrow/preview',buyerPreview),/escrow_close_container_survival_required/)
  await delay(650);await visitor.clickWindow(49,0,0)
  await poll(()=>visitor.currentWindow,value=>value===null,'ACTUAL_COLLECTION_REMAINS_CRAFTING')
  const actualCollectionStatus=await queued(visitor,'status');assert.deepEqual(JSON.parse(actualCollectionStatus.args[1]),{orderId:collectionOrder.orderId})
  // This visitor has only the shop compass: reaching item validation proves native CRAFTING/empty-cursor guards passed.
  await assert.rejects(native('escrow/preview',buyerPreview),/escrow_supported_noncontainer_item_lot_required/)
  assert.equal(visitor.currentWindow,null)
  assert.equal(stable(inventory(visitor)),buyerBeforePreview);assert.equal(stable(inventory(merchant)),merchantBeforePreview)
  await window(visitor,'Collect Materials',()=>native('inventory-shop/reply',{operationId:actualCollectionStatus.operationId,result:collectionOrder}))
  visitor.closeWindow(visitor.currentWindow)
  check('Collect materials closes the real shop; native custody preview enforces Survival/CRAFTING/empty-cursor and leaves both inventories unchanged',{paymentAndDelivery:'Synthetic paid-view fixture only; physical paid claim remains pending real human end-to-end verification',merchantNativePreviewId:merchantPreview.previewId,merchantPreviewFingerprint:merchantPreview.fingerprint,nativeGuard:'Open buyer shop refused; after Collect native item validation reached through unchanged clearActor guard',physicalClaimAttempted:false,inventoryEffects:0})

  const agentRegistry=join(meta.runtime,'mumbai-claude/personal-agents.json'),originalRegistry=await readFile(agentRegistry)
  const delegatedClaim={operationId:randomUUID(),mailboxId:randomUUID(),ownerId:actor.principalId,playerId:visitor._client.uuid,connectionId:(await session(visitor)).connectionId,recipientAgentId:bots.CityAgent5._client.uuid}
  const recipientInventory=inventory(bots.CityAgent5)
  try{
    await assert.rejects(native('escrow/claim',delegatedClaim),/escrow_owned_agent_recipient_required/)
    await writeFile(agentRegistry,JSON.stringify({version:1,agents:[{name:'CityAgent5',ownerId:actor.principalId,minecraftPlayerId:visitor._client.uuid}]}))
    await assert.rejects(native('escrow/claim',delegatedClaim),/escrow_listing_missing/)
    await assert.rejects(native('escrow/claim',{...delegatedClaim,recipientAgentId:merchant._client.uuid}),/escrow_owned_agent_recipient_required/)
    await assert.rejects(native('escrow/claim',{...delegatedClaim,connectionId:randomUUID()}),/escrow_approved_connection_required/)
    assert.deepEqual(inventory(bots.CityAgent5),recipientInventory)
  }finally{await writeFile(agentRegistry,originalRegistry)}
  check('Delegated native claim checks actual approved human session and persisted agent ownership before custody lookup; wrong recipients cannot receive goods',{scope:'Controlled isolated ownership fixture; missing mailbox prevents all deliveries. No payment or chain proof fabricated.',inventoryEffects:0})

  assert.deepEqual(await worldIds(),meta.sourceWorldIds)
  for(const [file,digest]of Object.entries(retained))assert.equal(hash(await readFile(join(meta.runtime,file))),digest,'Retained agent ownership/task history changed')
  report.worldIds=await worldIds();report.status='pass'
  check('Existing world UUIDs, controlled-agent ownership and retained task history remain unchanged after the native city checks')
}catch(error){report.error=error.message;report.errorStack=error.stack;process.exitCode=1}
finally{
  clearInterval(sweepTimer);await sweeping?.catch(()=>{report.fixtureSweepFailed=true})
  if(report.fixtureSweepFailed){report.status='fail';report.error||='ISOLATED_HOSTILE_CONTROL_FAILED';process.exitCode=1}
  for(const payload of locks){try{await native('task-lock',{...payload,locked:false})}catch{report.lockCleanupPending=true}}
  if(report.lockCleanupPending){report.status='fail';report.error||='MUMBAI_CITY_LOCK_CLEANUP_PENDING';process.exitCode=1}
  for(const bot of clients){bot.clearControlStates();bot.pathfinder?.setGoal(null);if(bot.currentWindow)bot.closeWindow(bot.currentWindow);bot.quit('Isolated UniRock verification finished')}
  report.finishedAt=new Date().toISOString()
  for(const path of ['plugin/src/main/java/org/agentcity/paper/UniRockBank.java','plugin/src/main/java/org/agentcity/paper/MumbaiWorld.java','plugin/src/main/java/org/agentcity/paper/PlayableExperience.java','plugin/src/main/java/org/agentcity/paper/InventoryMarketplace.java','plugin/src/main/java/org/agentcity/paper/AgentTaskProtection.java','plugin/src/main/java/org/agentcity/paper/InventoryEscrow.java','backend/src/playable/inventory-shop-runtime.mjs','backend/src/playable/survival-tools.mjs','backend/src/playable/survival-objectives.mjs','scripts/mumbai_agents.mjs','scripts/laptop_host.py','scripts/mumbai_city_host.py','tests/test_mumbai_city_host.py','tests/maps/mumbai-city-visit.mjs']){
    report.sources||={};report.sources[path]=path==='tests/maps/mumbai-city-visit.mjs'?executedTestSha256:path==='backend/src/playable/inventory-shop-runtime.mjs'?eventParserSourceSha256:hash(await readFile(join(root,path)))
  }
  const reportPath=join(directory,'report.json'),bytes=JSON.stringify(report,null,2)+'\n'
  await writeFile(reportPath,bytes)
  if(report.status==='pass'&&!report.lockCleanupPending){
    const proof={owner:'agentcity-mumbai-city-isolated-proof',status:'pass',isolatedId:meta.id,
      ...Object.fromEntries(['pluginSha256','serverId','worldUuid','sourceActiveSha256','sourceMumbaiConfigSha256','sourceWorldIds'].map(key=>[key,meta[key]])),
      report:relative(root,reportPath),reportSha256:hash(bytes)}
    await writeFile(marker,JSON.stringify(proof,null,2)+'\n',{mode:0o600})
  }
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,error:report.error,evidence:reportPath}))
}
