// Real isolated Paper fixture: generated blocks only, no live owner impersonation, grants or inference.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {execFile as execCallback} from 'node:child_process'
import {promisify} from 'node:util'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url),execFile=promisify(execCallback)
const mineflayer=require('../compatibility/node_modules/mineflayer'),{pathfinder,Movements,goals}=require('../compatibility/node_modules/mineflayer-pathfinder'),{Vec3}=require('../compatibility/node_modules/vec3')
const json=async p=>JSON.parse(await readFile(p,'utf8')),delay=ms=>new Promise(r=>setTimeout(r,ms)),sha=v=>createHash('sha256').update(v).digest('hex')
const isolated=await json(join(root,'.local/mumbai-city/isolated-active.json'))
assert.equal(isolated.owner,'agentcity-mumbai-city-isolated');assert(!isolated.cleaned)
assert.equal(isolated.container,'agentcity-mumbai-city-'+isolated.id.slice(0,8))
const token=(await readFile(join(isolated.runtime,'api-token'),'utf8')).trim(),deployment=await json(join(isolated.runtime,'plugins/AgentCity/deployment.json'))
const runId=randomUUID(),directory=join(root,'evidence/runs/calculator-workshop',runId)
const report={status:'fail',isolatedId:isolated.id,pluginSha256:isolated.pluginSha256,serverId:isolated.serverId,worldIds:isolated.sourceWorldIds,
 scope:'Controlled approved vanilla client on isolated world copy; Survival break/place, empty copied chest, lever controls and restart persistence',checks:[],liveWorldMutations:0,inferenceRequests:0,independentHumansVerified:0}
let bot;const messages=[],principalId=randomUUID(),name='Calc'+runId.slice(0,8),discordId=String(660000000000000000n+BigInt('0x'+runId.slice(0,8)))
async function api(path,body){
 const response=await fetch('http://127.0.0.1:25997/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)})
 const data=await response.json();assert(response.ok,'API '+response.status+' '+(data.reason||data.code||''));return data
}
async function wait(read,accept,label){const end=Date.now()+45000;while(Date.now()<end){const value=await read();if(accept(value))return value;await delay(100)}throw Error('Timeout: '+label)}
async function command(text,accept){const start=messages.length;bot.chat(text);return wait(()=>messages.slice(start),v=>v.some(l=>accept.test(l)),text)}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
async function connect(){
 await api('playable/discord/reserve',{playerName:name,principalId,discordId,accountKind:'local',expiresAtMs:Date.now()+240000})
 bot=mineflayer.createBot({host:'127.0.0.1',port:25996,username:name,auth:'offline',version:'1.21.11'})
 bot.on('error',()=>{});bot.on('messagestr',text=>messages.push(text));bot.on('physicsTick',()=>{if(bot._client.state==='play')bot._client.write('tick_end',{})})
 await Promise.race([once(bot,'spawn'),new Promise((_,reject)=>setTimeout(()=>reject(Error('spawn timeout')),40000).unref())])
 const playerId=bot._client.uuid,session=await wait(()=>api('playable/session?playerId='+playerId),s=>s.online&&s.connectionId,'session')
 return{playerId,...session}
}
async function approve(session){await api('playable/discord/approve',{playerId:session.playerId,connectionId:session.connectionId,principalId});await wait(()=>api('playable/session?playerId='+session.playerId),s=>s.pendingAuthentication===false,'approval')}
async function enter(){await command('/calculator',/Entered the editable calculator workshop/);await wait(()=>api('playable/session?playerId='+bot._client.uuid),s=>s.serverPosition?.world===deployment.world,'workshop arrival');await bot.waitForChunksToLoad();assert.equal(bot.game.gameMode,'survival')}
async function walk(position,range=2){await bot.pathfinder.goto(new goals.GoalNear(position.x,position.y,position.z,range));bot.pathfinder.setGoal(null)}
const count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
try{
 const canonicalBefore=(await api('status')).state
 const session=await connect();assert.equal(session.pendingAuthentication,true)
 await command('/calculator',/Approve this connection/)
 const denied=await api('playable/session?playerId='+session.playerId);assert.notEqual(denied.serverPosition?.world,deployment.world)
 pass('Unapproved connection cannot use calculator travel')
 await approve(session);await delay(700);await enter()
 bot.loadPlugin(pathfinder);const movements=new Movements(bot);movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;bot.pathfinder.setMovements(movements)
 const status=(await api('playable/status')).calculatorWorkshop;assert.equal(status.ready,true);assert.equal(status.containerContentsCopied,false)
 const originalChest=new Vec3(deployment.chest[0]+128,deployment.chest[1],deployment.chest[2])
 const chest=bot.blockAt(originalChest)?.name==='chest'?originalChest:bot.findBlocks({matching:b=>b.name==='chest',maxDistance:48,count:16})
  .find(p=>p.x>=status.min[0]&&p.x<=status.max[0]&&p.z>=status.min[2]&&p.z<=status.max[2])
 assert(chest,'existing generated workshop chest')
 await walk(chest);const before=bot.blockAt(chest);assert.equal(before.name,'chest')
 bot.setQuickBarSlot(8)
 const container=await bot.openContainer(before);assert.equal(container.containerItems().length,0);container.close()
 pass('Calculator copy has no duplicated reference-chest stock')
 const baseline=count('chest');await bot.dig(bot.blockAt(chest));await walk(chest,0)
 await wait(()=>count('chest'),n=>n===baseline+1,'one chest picked up')
 assert.equal(bot.blockAt(chest).name,'air')
 const candidates=[chest.offset(1,0,0),chest.offset(0,0,-1),chest.offset(2,0,0)]
 const moved=candidates.find(p=>bot.blockAt(p)?.name==='air'&&bot.blockAt(p.offset(0,-1,0))?.boundingBox==='block');assert(moved,'free floor beside original chest')
 await bot.equip(bot.inventory.items().find(i=>i.name==='chest'),'hand');await bot.placeBlock(bot.blockAt(moved.offset(0,-1,0)),new Vec3(0,1,0))
 await wait(()=>bot.blockAt(moved)?.name,n=>n==='chest','placed chest');await wait(()=>count('chest'),n=>n===baseline,'finite chest consumed')
 report.movedChest={from:chest.toArray(),to:moved.toArray()};pass('Approved Survival player can break, collect and reposition an actual calculator block')
 const lever=bot.findBlock({matching:b=>b.name==='lever',maxDistance:48});assert(lever,'copied calculator lever')
 await walk(lever.position);const powered=bot.blockAt(lever.position).getProperties().powered;await bot.activateBlock(bot.blockAt(lever.position))
 await wait(()=>bot.blockAt(lever.position)?.getProperties().powered,v=>v!==powered,'lever control')
 pass('Calculator lever interaction remains usable in Survival')
 assert.deepEqual((await api('status')).state,canonicalBefore)
 pass('Canonical reference-job state remains unchanged')
 await enter();assert.equal(bot.blockAt(chest).name,'air');assert.equal(bot.blockAt(moved).name,'chest')
 bot.quit();bot=null;await delay(500)
 const actual=JSON.parse((await execFile('docker',['inspect',isolated.container])).stdout)[0]
 assert.equal(actual.Config.Labels['agentcity.owner'],isolated.owner)
 await execFile('docker',['restart','--time','90',isolated.container],{timeout:120000})
 await wait(()=>api('playable/status').catch(()=>null),s=>s?.available&&s.mumbai?.ready,'isolated restart')
 await approve(await connect());await delay(700);await enter()
 assert.equal(bot.blockAt(chest).name,'air');assert.equal(bot.blockAt(moved).name,'chest')
 pass('Moved calculator blocks persist across a real Paper restart without recopying the template')
 const ids=JSON.parse((await execFile('python3',['-c','import sys,json;from pathlib import Path;sys.path.insert(0,"scripts");import mumbai_host;print(json.dumps(mumbai_host.world_ids(Path(sys.argv[1]))))',isolated.runtime],{cwd:root})).stdout)
 assert.deepEqual(ids,isolated.sourceWorldIds);pass('All seven existing world UUIDs remain unchanged')
 report.status='pass'
}catch(error){report.error=error.message;throw error}
finally{
 bot?.quit();report.fixtureMessages=messages.slice(-12);await mkdir(directory,{recursive:true});const path=join(directory,'report.json');await writeFile(path,JSON.stringify(report,null,2)+'\n')
 if(report.status==='pass')await writeFile(join(root,'.local/mumbai-city/isolated-verification.json'),JSON.stringify({owner:'agentcity-mumbai-city-isolated-proof',status:'pass',isolatedId:isolated.id,
  ...Object.fromEntries(['pluginSha256','serverId','worldUuid','sourceActiveSha256','sourceMumbaiConfigSha256','sourceWorldIds'].map(k=>[k,isolated[k]])),report:path.slice(root.length),reportSha256:sha(await readFile(path))},null,2)+'\n',{mode:0o600})
 console.log('Report: '+path)
}
