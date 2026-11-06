'use strict'

// Actual local fixture client. This is not independent-human identity evidence.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { once } = require('node:events')
const root = path.resolve(__dirname, '../..')
require(path.join(root,'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer = require(path.join(root,'tests/compatibility/node_modules/mineflayer'))
const { pathfinder, Movements, goals } = require(path.join(root,'tests/compatibility/node_modules/mineflayer-pathfinder'))
const username = process.env.AC_PLAYABLE_TEST_USER || 'LobbyTester'
assert.match(username,/^[A-Za-z0-9_]{3,16}$/)
assert.ok(!['Ruddy','CityAgent1','CityAgent2','WorldBuilder','WorldRequester','WorldInspector'].includes(username),'Use a disclosed dedicated fixture player')
const report = { scope:'Actual local lobby/play-world fixture; no independently authenticated human or blockchain action',
  username,status:'fail',independentHumansVerified:0,startedAt:new Date().toISOString(),checks:[],worldHistory:[] }
const messages=[]
let bot,currentWorld=null,disconnected=false
const delay = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds))
async function poll(read,condition,label,timeout=20000) {
  const deadline=Date.now()+timeout
  do {
    if(disconnected) throw Error('Fixture disconnected during '+label)
    const result=await read()
    if(condition(result)) return result
    await delay(100)
  } while(Date.now()<deadline)
  throw Error('Timed out waiting for '+label)
}
function check(name,details={}) { report.checks.push({name,status:'pass',...details});console.log(JSON.stringify({check:name,status:'pass',...details})) }
function recordWorld(packet) {
  const data=packet.worldState||packet
  const name=data.worldName??data.name
  if(typeof name==='string') {
    currentWorld=name
    report.worldHistory.push({worldName:currentWorld,isFlat:data.isFlat??null,at:new Date().toISOString()})
  }
}
async function connect() {
  disconnected=false;currentWorld=null
  bot=mineflayer.createBot({host:'127.0.0.1',port:25596,version:'1.21.11',auth:'offline',username,hideErrors:true,checkTimeoutInterval:30000})
  bot._client.on('login',recordWorld);bot._client.on('respawn',recordWorld)
  bot.on('messagestr',message=>{if(!/AC_SESSION/.test(message))messages.push(message)})
  bot.on('error',error=>{report.connectionError=error.message})
  bot.on('kicked',reason=>{report.kicked=String(reason);disconnected=true})
  bot.on('end',()=>{disconnected=true})
  await Promise.race([once(bot,'spawn'),delay(45000).then(()=>{throw Error('Fixture login timeout')})])
  bot.loadPlugin(pathfinder)
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false
  bot.pathfinder.setMovements(movement)
  await poll(()=>bot.game.gameMode,value=>value==='survival'||value===0,'Survival player')
}
const inventory=()=>bot.inventory.items().map(item=>({name:item.name,count:item.count,slot:item.slot})).sort((a,b)=>a.slot-b.slot)
const taggedNpcs=()=>Object.values(bot.entities).filter(entity=>entity.name==='villager'&&/Guide|Agent Desk|Job Board|Game Coins|Play/.test(JSON.stringify(entity.metadata)))
async function chat(command,pattern,timeout=30000) {
  await delay(650);const start=messages.length;bot.chat(command)
  return poll(()=>messages.slice(start),lines=>lines.some(line=>pattern.test(line)),command,timeout)
}
async function run() {
  await connect()
  await poll(()=>currentWorld,value=>/agentcity_lobby$/.test(value||''),'first-join lobby world')
  check('fixture-arrival-is-separate-survival-lobby',{world:currentWorld})
  const names=['Guide','Agent Desk','Job Board','Game Coins','Play']
  const npcs=await poll(taggedNpcs,entities=>names.every(name=>entities.some(entity=>JSON.stringify(entity.metadata).includes(name))),'five lobby NPCs')
  check('five-first-use-npcs-visible-in-lobby',{names})
  const playNpc=npcs.find(entity=>JSON.stringify(entity.metadata).includes('Play'))
  assert.ok(playNpc,'Play NPC was not found')
  bot.pathfinder.setGoal(new goals.GoalNear(playNpc.position.x,playNpc.position.y,playNpc.position.z,1))
  await poll(()=>bot.entity.position.distanceTo(playNpc.position),distance=>distance<2,'walk to Play NPC')
  bot.pathfinder.setGoal(null);await delay(250)
  const initialInventory=inventory()
  const opened=once(bot,'windowOpen')
  await bot.activateEntityAt(playNpc,playNpc.position.offset(0,1,0))
  const [window]=await Promise.race([opened,delay(10000).then(()=>{throw Error('Play menu did not open')})])
  assert.ok(JSON.stringify(window.title).includes('Play'))
  await bot.clickWindow(11,0,0)
  await poll(()=>currentWorld,value=>/agentcity_play$/.test(value||''),'actual play-world transition')
  await poll(()=>bot.entity.position,value=>Boolean(value)&&bot.blockAt(value.offset(0,-1,0))!==null,'play world chunks')
  assert.deepEqual(inventory(),initialInventory)
  assert.notEqual(bot.game.levelType,'flat')
  check('play-npc-opens-normal-resource-world-with-inventory-preserved',{world:currentWorld,levelType:bot.game.levelType})
  const resources=await poll(()=>bot.findBlocks({matching:[bot.registry.blocksByName.grass_block.id,bot.registry.blocksByName.dirt.id],maxDistance:32,count:4}),blocks=>blocks.length>0,'visible natural terrain resources')
  check('play-world-has-observed-natural-grass-or-dirt',{observedBlocks:resources.length})
  await delay(1000)
  assert.equal(taggedNpcs().length,0)
  check('lobby-npcs-are-absent-from-play-world')
  const created=await chat('/agent create',/CityAgent[12] is your personal agent/,45000)
  const name=created.find(line=>/CityAgent[12] is your personal agent/.test(line)).match(/CityAgent[12]/)[0]
  report.agent=name
  await poll(()=>bot.players[name]?.entity,entity=>Boolean(entity),'owned agent in play world')
  check('personal-agent-spawns-in-play-world',{agent:name})
  await chat('/agent wait',new RegExp(name+' stopped and is waiting'))
  const beforeLobby=inventory()
  await chat('/lobby',/Returned to agentcity_lobby/)
  await poll(()=>currentWorld,value=>/agentcity_lobby$/.test(value||''),'return to NPC lobby')
  assert.deepEqual(inventory(),beforeLobby)
  await poll(()=>bot.players[name]?.entity,entity=>!entity,'agent is not teleported to lobby')
  check('lobby-return-preserves-inventory-and-keeps-agent-in-play-world')
  await chat('/play',/Entered agentcity_play/)
  await poll(()=>currentWorld,value=>/agentcity_play$/.test(value||''),'return to gameplay')
  await poll(()=>bot.players[name]?.entity,entity=>Boolean(entity),'owned agent remains in play world')
  assert.deepEqual(inventory(),beforeLobby)
  const beforeReconnect=bot.entity.position.clone()
  const ended=once(bot,'end');bot.quit('Fixture reconnect check');await ended;await delay(4500)
  await connect()
  await poll(()=>currentWorld,value=>/agentcity_play$/.test(value||''),'saved gameplay world on reconnect')
  await poll(()=>bot.entity.position,value=>value.distanceTo(beforeReconnect)<2,'saved gameplay position on reconnect')
  assert.deepEqual(inventory(),beforeLobby)
  check('reconnect-preserves-gameplay-world-position-and-inventory',{world:currentWorld})
  await chat('/agent release',new RegExp(name+' was released'),45000)
  check('disclosed-fixture-agent-slot-released-with-owner-command')
  report.status='pass'
}
run().catch(error=>{report.error=error.message;process.exitCode=1}).finally(async()=>{
  if(bot&&!disconnected)bot.quit('Lobby fixture smoke complete')
  report.finishedAt=new Date().toISOString()
  if(process.env.AC_PLAYABLE_TEST_REPORT){await fs.mkdir(path.dirname(process.env.AC_PLAYABLE_TEST_REPORT),{recursive:true});await fs.writeFile(process.env.AC_PLAYABLE_TEST_REPORT,JSON.stringify(report,null,2)+'\n')}
  console.log(JSON.stringify(report))
})
