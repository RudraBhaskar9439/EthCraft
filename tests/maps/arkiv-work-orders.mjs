// Actual owned isolated Paper copy; controlled offline principal and scripted planner.
// No real owner approval, paid inference, wallet signature or public publication.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises'
import {resolve,join,relative} from 'node:path'
import {createRequire} from 'node:module'
import {randomUUID,createHash} from 'node:crypto'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {WorkOrders} from '../../backend/src/arkiv/work-orders.mjs'
import {SurvivalObjectives} from '../../backend/src/playable/survival-objectives.mjs'
import {validateWorkRecord,workerSlots} from '../../backend/src/arkiv/work-order-schema.mjs'

const root=resolve(new URL('../..',import.meta.url).pathname),json=async p=>JSON.parse(await readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex')
assert.equal(process.argv.length,2)
const meta=await json(join(root,'.local/mumbai-city/isolated-active.json'))
assert.equal(meta.owner,'agentcity-mumbai-city-isolated');assert.match(meta.id,/^[a-f0-9]{32}$/);assert(!meta.cleaned)
assert.equal(meta.runtime,join(root,'.local/mumbai-city/isolated',meta.id));assert.equal(meta.container,'agentcity-mumbai-city-'+meta.id.slice(0,8));assert.equal(meta.controlPort,25997);assert.equal(meta.gamePort,25996)
const token=(await readFile(join(meta.runtime,'api-token'),'utf8')).trim()
assert.equal(hash(await readFile(join(meta.runtime,'plugins/AgentCity.jar'))),meta.pluginSha256)
const runId=randomUUID(),directory=join(root,'evidence/runs/arkiv-work-orders-native',runId),marker=join(root,'.local/mumbai-city/isolated-verification.json')
await mkdir(directory,{recursive:true});try{await rename(marker,marker+'.previous-'+runId)}catch(e){if(e.code!=='ENOENT')throw e}
const report={schema:'ethcraft.arkiv-native-work-orders.v1',status:'fail',runId,isolatedId:meta.id,pluginSha256:meta.pluginSha256,serverId:meta.serverId,worldIds:meta.sourceWorldIds,scope:'Controlled isolated offline owner, two real Minecraft agents, scripted decisions and local publication fixtures. No real-user or independent inspection qualification.',paidModelCalls:0,walletSignatures:0,publicTransactions:0,fixtureMaterialGrant:'Exactly two oak planks in isolated first source chest; isolated target chests cleared',checks:[]}
const require=createRequire(new URL('../compatibility/package.json',import.meta.url)),mineflayer=require('mineflayer'),{pathfinder,Movements}=require('mineflayer-pathfinder')
const clients=[],saved=[],objectives={};let orders
const check=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
async function request(path,body){const r=await fetch('http://127.0.0.1:25997/playable/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(15000)});return{status:r.status,value:await r.json()}}
async function native(path,body){const r=await request(path,body);if(r.status!==200)throw Error('NATIVE_'+path.split('?')[0]+'_'+JSON.stringify(r.value));return r.value}
async function poll(read,accept,label,ms=30000){const end=Date.now()+ms;do{const value=await read();if(accept(value))return value;await delay(200)}while(Date.now()<end);throw Error('TIMEOUT_'+label)}
async function connect(name){
 await delay(4500);const bot=mineflayer.createBot({host:'127.0.0.1',port:25996,username:name,auth:'offline',version:'1.21.11',hideErrors:true,checkTimeoutInterval:120000});clients.push(bot)
 bot.on('error',e=>{report.clientError=e.message});bot.on('physicsTick',()=>{if(bot._client.state==='play')bot._client.write('tick_end',{})})
 await Promise.race([once(bot,'spawn'),once(bot,'kicked').then(()=>{throw Error('FIXTURE_CLIENT_KICKED')}),delay(30000).then(()=>{throw Error('FIXTURE_SPAWN_TIMEOUT')})]);await bot.waitForChunksToLoad();bot.loadPlugin(pathfinder);bot.pathfinder.setMovements(new Movements(bot));return bot
}
const rconPassword=(await readFile(join(meta.runtime,'server.properties'),'utf8')).split('\n').find(s=>s.startsWith('rcon.password='))?.slice(14);assert(rconPassword)
async function fixtureCommands(commands){
 const packet=(id,type,text)=>{const b=Buffer.concat([Buffer.alloc(8),Buffer.from(text),Buffer.alloc(2)]);b.writeInt32LE(id);b.writeInt32LE(type,4);const n=Buffer.alloc(4);n.writeInt32LE(b.length);return Buffer.concat([n,b]).toString('base64')}
 await new Promise((resolve,reject)=>{const child=execFile('docker',['exec','-i',meta.container,'bash','-c','exec 3<>/dev/tcp/127.0.0.1/25575; while IFS= read -r encoded; do printf "%s" "$encoded" | base64 -d >&3; sleep 0.3; done; timeout 1 cat <&3'],{timeout:15000,maxBuffer:32768},error=>error&&error.code!==124?reject(Error('ISOLATED_FIXTURE_CONTROL_FAILED')):resolve());child.stdin.end([packet(1,3,rconPassword),...commands.map((c,i)=>packet(i+2,2,c))].join('\n')+'\n')})
}
try{
 const world=await native('status');assert.equal(world.mumbai.worldUuid,meta.worldUuid);assert(world.mumbai.survival);assert.equal(world.mumbai.bank.stockGranted,0)
 const owner=randomUUID(),name='Arkiv'+runId.slice(0,7)
 await native('discord/reserve',{playerName:name,principalId:owner,discordId:String(780000000000000000n+BigInt('0x'+runId.replaceAll('-','').slice(0,12))),accountKind:'local',expiresAtMs:Date.now()+3600000})
 const visitor=await connect(name),session=await native('session?playerId='+visitor._client.uuid),input={playerId:visitor._client.uuid,connectionId:session.connectionId,ownerId:owner,items:['oak_planks','stick']}
 assert.notEqual((await request('work-observe',input)).status,200)
 await native('discord/approve',{playerId:input.playerId,connectionId:input.connectionId,principalId:owner})
 for(const [worker,slotName]of Object.entries(workerSlots)){
  const bot=await connect(slotName),file=join(meta.runtime,'mumbai-'+worker,'personal-agents.json');saved.push({file,bytes:await readFile(file)})
  await writeFile(file,JSON.stringify({version:1,agents:[{name:slotName,ownerId:owner,minecraftPlayerId:input.playerId}]}))
  const slot={name:slotName,ownerId:owner,minecraftPlayerId:input.playerId,bot},manager={runtime:join(meta.runtime,'work-order-fixture',worker),names:[slotName],slots:[slot],taskRegions:world.taskRegions,ensureBot:async()=>{},inPlayWorld:()=>true,stop:s=>s.bot.pathfinder.stop(),tools:{unfinished:()=>false},providerForSlot:()=>({kind:'anthropic'})}
  objectives[worker]=await new SurvivalObjectives({rootDirectory:root,manager,world,api:native,modelCall:async()=>{
   const job=objectives[worker].latest(owner),stage=orders.owned(job.workOrder.orderId,owner).spec.stages[job.workOrder.stage],steps=[{tool:'withdraw',item:'oak_planks',count:2,position:stage.source.position},...(job.workOrder.stage===1?[{tool:'craft',item:'stick',count:4}]:[]),{tool:'deposit',item:stage.item,count:stage.count,position:stage.destination.position}]
   return{status:'act',message:'Controlled native stage.',step:steps[job.history.length]}
  }}).initialize()
 }
 const before=await native('work-observe',input)
 assert.equal(before.serverId,meta.serverId);assert.equal(before.worldUuid,meta.worldUuid);assert.equal(Object.keys(before.agents).length,2)
 for(const change of [{ownerId:randomUUID()},{connectionId:randomUUID()},{position:[0,0,0]},{items:['oak_planks','stick','diamond']},{items:['not_a_real_item']}])assert.notEqual((await request('work-observe',{...input,...change})).status,200)
 check('Real native observer rejects unapproved, wrong-owner, stale-connection, arbitrary-coordinate and invalid-material requests')
 const source=world.taskRegions.find(r=>r.slotName==='CityAgent5'),target=world.taskRegions.find(r=>r.slotName==='CityAgent4')
 const commands=[source.sourceChest,target.sourceChest,target.destinationChest].map(p=>'execute in minecraft:agentcity_mumbai run data modify block '+p.join(' ')+' Items set value []')
 commands.push('execute in minecraft:agentcity_mumbai run item replace block '+source.sourceChest.join(' ')+' container.0 with minecraft:oak_planks 2')
 await fixtureCommands(commands);await delay(500)
 const server='a'.repeat(64),records=new Map();let seq=0
 const reader={server,orders:{get:async key=>structuredClone(records.get(key)),list:async()=>({records:[...records.values()]})}},publisher={publish:async r=>{validateWorkRecord(r,server);const row={...structuredClone(r),entityKey:'0x'+(++seq).toString(16).padStart(64,'0')};records.set(row.entityKey,row);return row}}
 orders=await new WorkOrders({rootDirectory:join(meta.runtime,'work-order-fixture'),reader,publisher,api:native,serverId:meta.serverId,regions:world.taskRegions}).initialize()
 for(const o of Object.values(objectives))o.workOrders=orders
 const event=()=>({playerId:owner,actorPlayerId:input.playerId,connectionId:input.connectionId,operationId:randomUUID()})
 await orders.create({worker:'claude',event:event(),kind:'craft_delivery',item:'stick',count:4,objectives});const order=orders.state.orders[0];order.fixture=true
 await orders.claim({worker:'claude',event:event(),id:order.id,objectives});await poll(()=>order.status,s=>s!=='working','SUPPLY',90000);await objectives.claude.running.get(owner)
 report.sourceJob=objectives.claude.latest(owner);assert.equal(order.status,'awaiting_handoff',report.sourceJob.message);assert.equal(order.verifications.length,1)
 check('First real Minecraft worker withdraws and supplies exactly two planks; Paper and receipts verify stage one')
 await orders.claim({worker:'0g',event:event(),id:order.id,objectives});await poll(()=>order.status,s=>s!=='working','CRAFT',90000);await objectives['0g'].running.get(owner)
 report.targetJob=objectives['0g'].latest(owner);assert.equal(order.status,'completed',report.targetJob.message)
 const after=await native('work-observe',input);assert.equal(after.containers.CityAgent4.destinationChest.items.stick,4)
 assert.equal(order.verifications.length,2);report.proofs=order.verifications;report.observation=after
 check('Second real worker reads remaining stage, crafts four sticks and deposits them; exact native deltas and agent inventory conservation pass')
 const {stdout}=await promisify(execFile)('python3',['-c','import json,sys;from pathlib import Path;from scripts.mumbai_city_host import mumbai;print(json.dumps(mumbai.world_ids(Path(sys.argv[1]))))',meta.runtime],{cwd:root});assert.deepEqual(JSON.parse(stdout),meta.sourceWorldIds)
 check('All seven world identities remain unchanged');report.status='pass'
}catch(error){report.error=error.message;report.stack=error.stack;process.exitCode=1}
finally{
 await Promise.allSettled(Object.values(objectives).map(o=>o.close()))
 for(const s of saved)await writeFile(s.file,s.bytes)
 for(const bot of clients){bot.pathfinder?.stop();bot.quit('Isolated Arkiv check finished')}
 report.finishedAt=new Date().toISOString();report.testSha256=hash(await readFile(new URL(import.meta.url)))
 // Private raw task observations stay in the ignored runtime; commit only this sanitized report.
 delete report.sourceJob;delete report.targetJob
 const path=join(directory,'report.json'),bytes=JSON.stringify(report,null,2)+'\n';await writeFile(path,bytes)
 if(report.status==='pass')await writeFile(marker,JSON.stringify({owner:'agentcity-mumbai-city-isolated-proof',status:'pass',isolatedId:meta.id,...Object.fromEntries(['pluginSha256','serverId','worldUuid','sourceActiveSha256','sourceMumbaiConfigSha256','sourceWorldIds'].map(k=>[k,meta[k]])),report:relative(root,path),reportSha256:hash(bytes)},null,2)+'\n',{mode:0o600})
 console.log(JSON.stringify({status:report.status,error:report.error,evidence:path}))
}
