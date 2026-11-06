// Controlled offline fixtures: no game clients, model calls, transactions or owner approvals.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { stringToHex, encodeEventTopics, encodeAbiParameters } from '../../backend/node_modules/viem/_esm/index.js'
import { ENTITY_EVENTS_ABI } from '../../backend/node_modules/@arkiv-network/sdk-rabdi/dist/index.js'
import { projectProgress, validateProgress, createTaskReader, TaskPublisher, engineAddress, publisherAddress, serverNamespace } from '../../backend/src/arkiv/tasks.mjs'
import { handoffTask } from '../../backend/src/arkiv/runtime.mjs'
import { mumbaiAgentCommand } from '../../scripts/mumbai_agents.mjs'
import { SurvivalObjectives } from '../../backend/src/playable/survival-objectives.mjs'

const server=serverNamespace('controlled-fixture'),ownerId=randomUUID(),entityKey='0x'+'ab'.repeat(32)
const sourceJob={id:randomUUID(),ownerId,goal:'PRIVATE PROMPT secret-do-not-publish',status:'paused',arkivShared:true,history:[{step:{tool:'craft',item:'stick',count:4},result:{produced:4,privateValue:'secret-do-not-publish'}}],pendingEffect:null}
const projected=projectProgress(sourceJob,'claude',server)
assert(!JSON.stringify(projected).includes('secret-do-not-publish'));assert(!JSON.stringify(projected).includes(ownerId))
assert.equal(projected.facts.actions[0].produced,4)
for(const change of [{server:'other'},{status:'funded'},{provider:'administrator'},{facts:{...projected.facts,permission:'spend'}},{facts:{...projected.facts,actions:[{tool:'exec'}]}},{facts:{...projected.facts,actions:[{tool:'place',position:[NaN,0,0]}]}}])assert.throws(()=>validateProgress({...projected,...change},server),/ARKIV_PROGRESS_INVALID/)
for(const command of ['agent board','0g publish','agent unshare','0g handoff '+sourceJob.id])assert.equal(mumbaiAgentCommand({action:'agent',args:command}).event.action,'agent')
const row={...Object.fromEntries(['server','task','job','provider','status'].map(k=>[k,{value:projected[k]}])),facts:{value:stringToHex(JSON.stringify(projected.facts))},revision:{value:2n},$key:entityKey,$owner:publisherAddress,$expiresAt:12345n}
let queriedOwner,queriedLimit
const query={from(){return this},ownedBy(o){queriedOwner=o;return this},where(){return this},orderBy(){return this},limit(n){queriedLimit=n;return this},offset(){return this},async fetch(){return {entities:[row,{...row,revision:{value:1n}}, {...row,$owner:'0x'+'00'.repeat(20)}],skipped:0,blockNumber:100n}}}
const reader=createTaskReader({server,client:{select:()=>query,getEntity:async()=>row}})
const page=await reader.list()
assert.equal(queriedOwner,publisherAddress);assert.equal(queriedLimit,100);assert.equal(page.records.length,1);assert.equal(page.records[0].revision,2);assert.equal(page.rejected,1)
assert.equal((await reader.list({status:'running'})).records.length,0)
await assert.rejects(reader.list({offset:-1}),/ARKIV_QUERY_INVALID/)
await assert.rejects(reader.get('not-a-key'),/ARKIV_ENTITY_KEY_REQUIRED/)

const directory=await mkdtemp(join(tmpdir(),'ethcraft-arkiv-'))
try {
  let rebroadcasts=0,reads=0
  const transactionHash='0x'+'cd'.repeat(32)
  const log={address:engineAddress,topics:encodeEventTopics({abi:ENTITY_EVENTS_ABI,eventName:'EntityCreated',args:{entityKey,owner:publisherAddress}}),data:encodeAbiParameters([{type:'uint64'},{type:'uint8'}],[12345n,1])}
  const record={...projected}
  const entry={fingerprint:createHash('sha256').update(JSON.stringify(record)).digest('hex'),record,revision:2,status:'submitted',rawTransaction:'0xdead',transactionHash,reservedCost:'100'}
  const receiptReader={server,get:async()=>({...record,entityKey,revision:2}),client:{
    async getTransactionReceipt(){reads++;if(reads===1){const error=Error('not found');error.name='TransactionReceiptNotFoundError';throw error}return {status:'success',logs:[log]}},
    async request(request){assert.equal(request.method,'eth_sendRawTransaction');assert.deepEqual(request.params,['0xdead']);rebroadcasts++},
    async waitForTransactionReceipt(){return {status:'success',logs:[log]}}
  }}
  const state={version:1,server,publisher:publisherAddress,entries:[entry]}
  const publisher=new TaskPublisher({reader:receiptReader,file:join(directory,'state.json'),state})
  assert.equal((await publisher.publish(record)).entityKey,entityKey)
  assert.equal(rebroadcasts,1);assert.equal(state.entries.length,1);assert.equal(entry.status,'confirmed')
  await publisher.publish(record);assert.equal(rebroadcasts,1)
  const expired=new TaskPublisher({reader:{...receiptReader,get:async()=>{const error=Error('expired');error.name='NoEntityFoundError';throw error}},file:join(directory,'expired.json'),state})
  await assert.rejects(expired.publish(record),/ARKIV_SHARED_RECORD_EXPIRED/);assert.equal(state.entries.length,1)
  // A process restart recovers the same signed operation, not a replacement publication.
  const restarted=new TaskPublisher({reader:receiptReader,file:join(directory,'state.json'),state:JSON.parse(JSON.stringify(state))})
  assert.equal((await restarted.publish(record)).transactionHash,transactionHash)
  const bad=new TaskPublisher({reader:{...receiptReader,get:async()=>({...record,status:'running',entityKey,revision:2})},file:join(directory,'bad.json'),state:{...state,entries:[]}})
  await assert.rejects(bad.reconcile({...entry,entityKey:null,status:'submitted'}),/ARKIV_RECEIPT_CONTENT_MISMATCH/)
  let starts=0,publications=0,chainReads=0
  const job=structuredClone(sourceJob),targetJobs=[],event={playerId:ownerId,operationId:randomUUID(),connectionId:randomUUID()}
  const source={state:{jobs:[job]},running:new Map(),latest:id=>id===ownerId?job:null,save:async()=>{},stop:async()=>{job.status='paused'}}
  const target={state:{jobs:targetJobs},running:new Map(),latest:()=>targetJobs.at(-1),status:()=> 'resumed task',async start(e,goal,context){assert.equal(goal,sourceJob.goal);assert(job.handoffIntent);starts++;targetJobs.push({ownerId,operationId:e.operationId,sharedProgress:context});return 'accepted'}}
  const args={provider:'0g',objectives:{claude:source,'0g':target},event,jobId:job.id,server,onProgress:()=>{},publisher:{async publish(record){publications++;return {...record,entityKey}}},reader:{async get(){chainReads++;return {...projectProgress(job,'claude',server),entityKey}}}}
  job.pendingEffect={action:'place'}
  await assert.rejects(handoffTask(args),/ARKIV_PENDING_EFFECT_BLOCKS_HANDOFF/)
  assert.equal(starts,0);assert.equal(publications,0);assert.equal(job.handoffIntent,undefined)
  job.pendingEffect=null
  job.status='ready_for_review'
  await assert.rejects(handoffTask({...args,event:{...event,playerId:randomUUID()}}),/ARKIV_OWNED_SOURCE_TASK_REQUIRED/)
  assert.match(await handoffTask(args),/accepted/);assert.equal(starts,1);assert.equal(chainReads,1);assert.equal(job.status,'handed_off')
  assert.equal(targetJobs[0].sharedProgress.entityKey,entityKey)
  await handoffTask(args);assert.equal(starts,1);assert.equal(publications,1)
  const playerId=randomUUID(),connectionId=randomUUID(),slot={ownerId,minecraftPlayerId:playerId,bot:{}}
  let modelContext,progressUpdates=0
  const objectives=await new SurvivalObjectives({rootDirectory:directory,manager:{runtime:join(directory,'objective'),names:['CityAgent5'],slots:[slot],ensureBot:async()=>{},inPlayWorld:()=>true,stop:()=>{},tools:{unfinished:()=>false},providerForSlot:()=>({kind:'anthropic'})},world:{},
    api:async path=>path.startsWith('session?')?{online:true,pendingAuthentication:false,principalId:ownerId,connectionId,serverPosition:{world:'agentcity_mumbai'}}:{},
    toolsFactory:()=>({observe:async()=>({inventory:{},health:20,hunger:20})}),onProgress:()=>progressUpdates++,
    modelCall:async messages=>{modelContext=JSON.parse(messages.at(-1).content);return {status:'blocked',message:'Controlled fixture: no effects requested.'}}
  }).initialize()
  await objectives.start({playerId:ownerId,actorPlayerId:playerId,connectionId,operationId:randomUUID()},'Inspect the existing work before continuing.',{entityKey,rootTask:sourceJob.id,provider:'claude',facts:projected.facts})
  await objectives.running.get(ownerId)
  assert.equal(modelContext.sharedProgress.entityKey,entityKey);assert.equal(objectives.latest(ownerId).arkivShared,true);assert(progressUpdates>0)
  objectives.latest(ownerId).handoffIntent={operationId:randomUUID(),provider:'0g'}
  assert.match(await objectives.start({playerId:ownerId,actorPlayerId:playerId,connectionId,operationId:randomUUID()},'resume'),/saved Arkiv handoff/)
  await objectives.close()
  console.log('PASS typed public projection and privacy; owner-filtered, latest-state reads; immutable receipt recovery and duplicate suppression; approved command routing; pending-effect and wrong-owner handoff rejection; chain-read handoff and idempotent retry; shared context reaches the real objective loop and source resume is fenced')
}finally{await rm(directory,{recursive:true,force:true})}
