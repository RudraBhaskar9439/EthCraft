// Isolated fixtures: no models, chain calls or real Minecraft effects.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NativeTaskAdapter } from '../../backend/src/playable/task-tools.mjs'
import { SurvivalTools, validateSurvivalTool } from '../../backend/src/playable/survival-tools.mjs'
import { SurvivalObjectives, requestSurvivalDecision } from '../../backend/src/playable/survival-objectives.mjs'

for (const bad of [{tool:'wallet'}, {tool:'gather',item:'oak_log',count:0}, {tool:'place',item:'stone',position:[1,2]}, {tool:'hunt',animal:'player',count:1}, {tool:'move',position:[0,1,2],command:'/op me'}]) assert.throws(()=>validateSurvivalTool(bad))
assert.equal(validateSurvivalTool({tool:'craft',item:'wooden_pickaxe',count:1}).item,'wooden_pickaxe')
console.log('PASS strict Survival tools reject commands, spending, unsupported targets and invalid quantities')
const navigationBot={entity:{position:null},pathfinder:{movements:{original:true},setMovements(m){this.movements=m}}}
const navigationTools=new SurvivalTools({rootDirectory:fileURLToPath(new URL('../..',import.meta.url)),slot:{bot:navigationBot},world:{mumbaiAgentBounds:{min:{x:0,y:0,z:0},max:{x:100,y:100,z:100}}},guard:async()=>{}})
navigationBot.entity.position=new navigationTools.Vec3(10,69,10)
navigationTools.Movements=class{}
const originalWalker=NativeTaskAdapter.prototype.walk
try{
  NativeTaskAdapter.prototype.walk=async function(position){assert.equal(this.bot.pathfinder.movements.canDig,false);assert.equal(this.bot.pathfinder.movements.allowParkour,false);assert.equal(this.bot.pathfinder.movements.getMoveDiagonal(),undefined);this.bot.entity.position=new navigationTools.Vec3(...position)}
  assert.deepEqual((await navigationTools.move([20,69,20])).position,[20,69,20])
  assert.equal(navigationBot.pathfinder.movements.original,true)
}finally{NativeTaskAdapter.prototype.walk=originalWalker}
console.log('PASS Survival movement uses calibrated cardinal walking, disables diagonal clipping and restores prior movements')
let selectedCalls=0
const selected=await requestSurvivalDecision(async(_messages,schema)=>{selectedCalls++;return selectedCalls===1?{status:'act',message:'Craft sticks.',tool:'craft'}:(assert.deepEqual(schema.required,['item','count']),{item:'stick',count:4})},[{role:'user',content:'Craft four sticks.'}],'0g')
assert.deepEqual(selected.step,{tool:'craft',item:'stick',count:4});assert.equal(selectedCalls,2)
let injection=0
await assert.rejects(requestSurvivalDecision(async()=>++injection===1?{status:'act',message:'Craft.',tool:'craft'}:{tool:'gather',item:'oak_log',count:1},[{role:'user',content:'Craft.'}],'0g'),/INVALID_SURVIVAL_ARGUMENTS/)
console.log('PASS 0G tool selection uses flat required arguments and cannot change the selected tool through extra fields')

const tool=Object.create(SurvivalTools.prototype)
let stock={oak_planks:2},pending=null,receipts=0
const bot={inventory:{items:()=>Object.entries(stock).filter(([,count])=>count).map(([name,count])=>({name,count,type:name==='stick'?1:2}))},registry:{itemsByName:{stick:{id:1}},blocksByName:{crafting_table:{id:3}}},findBlock:()=>null,recipesFor:()=>[{requiresTable:false,result:{count:4}}],craft:async()=>{stock={oak_planks:0,stick:4}}}
tool.slot={bot};tool.guard=async()=>{};tool.beforeEffect=async r=>{pending=r};tool.receipt=async()=>{receipts++;pending=null}
const crafted=await tool.execute({tool:'craft',item:'stick',count:3})
assert.equal(crafted.produced,4);assert.equal(stock.stick,4);assert.equal(receipts,1);assert.equal(pending,null)
bot.craft=async()=>{};stock={oak_planks:2};await assert.rejects(tool.execute({tool:'craft',item:'stick',count:4}),/CRAFT_RECEIPT_UNCERTAIN/)
assert.equal(receipts,1);assert.equal(pending.action,'craft')
console.log('PASS real recipe batches and inventory deltas guard craft success; unknown effects retain pending intent')

const directory=await mkdtemp(join(tmpdir(),'agentcity-survival-'))
try {
  const ownerId=randomUUID(),playerId=randomUUID(),connectionId=randomUUID()
  const slot={name:'CityAgent5',ownerId,minecraftPlayerId:playerId,bot:{pathfinder:{stop(){}},clearControlStates(){}}}
  let approved=true,calls=0,locked=false
  const manager={runtime:directory,names:['CityAgent5'],slots:[slot],taskRegions:[{slotName:'CityAgent5',origin:[10,69,10]}],tools:{unfinished:()=>null},ensureBot:async()=>slot.bot,inPlayWorld:()=>true,stop(){}}
  slot.bot.entity={position:{x:10,y:69,z:10}}
  const api=async(path,input)=>{if(path.startsWith('session?'))return{online:true,pendingAuthentication:!approved,principalId:ownerId,connectionId,serverPosition:{world:'agentcity_mumbai'}};if(path==='task-lock')locked=input.locked;return{}}
  const world={mumbaiAgentBounds:{min:{x:0,y:0,z:0},max:{x:100,y:200,z:100}}}
  const engine=await new SurvivalObjectives({rootDirectory:directory,manager,world,api,
    modelCall:async()=>{calls++;return calls===1?{status:'act',message:'Look for wood.',step:{tool:'gather',item:'oak_log',count:1}}:calls===2?{status:'act',message:'Use the carried planks instead.',step:{tool:'craft',item:'stick',count:4}}:{status:'done',message:'Four sticks are observed; ready for owner review.'}},
    toolsFactory:({guard})=>({observe:async()=>{await guard();return{inventory:{oak_planks:2}}},execute:async step=>{await guard();if(step.tool==='gather')throw Error('RESOURCE_NOT_OBSERVED');return{produced:4,item:'stick'}}})
  }).initialize()
  const event={operationId:randomUUID(),playerId:ownerId,actorPlayerId:playerId,connectionId}
  await engine.start(event,'Make four sticks from available wood.')
  await engine.running.get(ownerId)
  assert.equal(engine.latest(ownerId).status,'ready_for_review');assert.equal(calls,3);assert.equal(locked,false)
  assert.equal(engine.latest(ownerId).history[0].error,'RESOURCE_NOT_OBSERVED')
  await engine.start(event,'Make four sticks from available wood.');assert.equal(calls,3)
  assert.equal(JSON.parse(await readFile(engine.file,'utf8')).jobs.length,1)
  console.log('PASS objective loop replans from a real tool failure, records evidence, reaches review and deduplicates original requests')
  let navigationCalls=0
  engine.modelCall=async()=>({status:'act',message:'Try the next safe waypoint.',step:{tool:'move',position:[20+navigationCalls++,69,20]}})
  engine.toolsFactory=({guard})=>({observe:async()=>{await guard();return{}},execute:async()=>{throw Error('PATH_TIMEOUT')}})
  await engine.start({...event,operationId:randomUUID()},'Walk to the source chest.')
  await engine.running.get(ownerId)
  assert.equal(navigationCalls,3);assert.equal(engine.latest(ownerId).status,'paused')
  assert.equal(engine.latest(ownerId).message,'NAVIGATION_BLOCKED_AFTER_THREE_ATTEMPTS')
  console.log('PASS three failed navigation attempts pause paid planning even when the model changes waypoints')
  approved=false
  await assert.rejects(engine.start({...event,operationId:randomUUID()},'Collect food.'),/OWNER_CONNECTION_NOT_APPROVED/)
  assert.equal(calls,3)
  approved=true
  const job=engine.latest(ownerId);job.status='paused';job.pendingEffect={action:'craft',item:'stick'};await engine.save()
  const reply=await engine.start({...event,operationId:randomUUID()},'resume')
  assert(reply.includes('reconciliation'));assert.equal(calls,3)
  await engine.close()
  console.log('PASS owner logout blocks inference/effects; interrupted intent survives restart and cannot be automatically replayed')
} finally {await rm(directory,{recursive:true,force:true})}
