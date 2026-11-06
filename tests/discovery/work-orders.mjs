// Controlled offline fixtures; no real owner, game, model, wallet or chain actions.
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {WorkOrders} from '../../backend/src/arkiv/work-orders.mjs'
import {makeWorkSpec,validateWorkRecord,workDigest,workerSlots,withWorkOrders} from '../../backend/src/arkiv/work-order-schema.mjs'
import {SurvivalObjectives} from '../../backend/src/playable/survival-objectives.mjs'
import {validateProgress,TaskPublisher,engineAddress,publisherAddress} from '../../backend/src/arkiv/tasks.mjs'
import {stringToHex,encodeEventTopics,encodeAbiParameters} from '../../backend/node_modules/viem/_esm/index.js'
import {ENTITY_EVENTS_ABI} from '../../backend/node_modules/@arkiv-network/sdk-rabdi/dist/index.js'
import {createHash} from 'node:crypto'

const root=await mkdtemp(join(tmpdir(),'arkiv-work-orders-')),server='a'.repeat(64),owner=randomUUID(),player=randomUUID(),connectionId=randomUUID(),worldUuid=randomUUID()
const regions=Object.values(workerSlots).map((slotName,i)=>({slotName,sourceChest:[10+i*16,69,10],destinationChest:[10+i*16,69,12],origin:[10+i*16,69,14]}))
const event=()=>({playerId:owner,actorPlayerId:player,connectionId,operationId:randomUUID()})
const valid=makeWorkSpec({id:randomUUID(),kind:'craft_delivery',item:'stick',count:4,worker:'claude',regions})
assert.equal(valid.input.count,2)
assert.throws(()=>makeWorkSpec({...valid,id:randomUUID(),worker:'claude',count:3,regions}),/WORK_ORDER_(?:SPEC|RECIPE)_INVALID/)
assert.equal(workDigest(valid),workDigest({...valid,input:{count:2,item:'oak_planks'}}))
let nativeCalls=0,reads=0,failPublication=false,sequence=0
const rows=new Map(),publications=[]
const reader={server,orders:{get:async key=>{reads++;return structuredClone(rows.get(key))},list:async()=>({records:[...rows.values()].reverse().filter((r,i,a)=>a.findIndex(x=>x.order===r.order)===i)})}}
const publisher={async publish(record){validateWorkRecord(record,server);if(failPublication)throw Error('ARKIV_PUBLICATION_PENDING');publications.push(structuredClone(record));const result={...structuredClone(record),entityKey:'0x'+(++sequence).toString(16).padStart(64,'0'),transactionHash:'0x'+'bc'.repeat(32)};rows.set(result.entityKey,result);return result}}
const stock={containers:Object.fromEntries(regions.map(r=>[r.slotName,Object.fromEntries(['sourceChest','destinationChest'].map(role=>[role,{position:r[role],items:{oak_planks:role==='sourceChest'?8:0,stick:0}}]))])),agents:Object.fromEntries(Object.values(workerSlots).map(n=>[n,{oak_planks:0,stick:0}]))}
const api=async(path,input)=>{
  if(path==='work-observe'){nativeCalls++;assert.equal(input.ownerId,owner);assert.equal(input.connectionId,connectionId);return{version:1,serverId:'fixture',worldUuid,observedAtMs:Date.now(),...structuredClone(stock)}}
  if(path.startsWith('session?'))return{online:true,pendingAuthentication:false,principalId:owner,connectionId,serverPosition:{world:'agentcity_mumbai'}}
  return{}
}
const objectives={}
const orders=await new WorkOrders({rootDirectory:root,reader,publisher,api,serverId:'fixture',regions}).initialize()
try{
  for(const [worker,name]of Object.entries(workerSlots)){
    const slot={name,ownerId:owner,minecraftPlayerId:player,bot:{entity:{position:{x:10,y:69,z:10}}}},manager={runtime:join(root,worker),names:[name],slots:[slot],taskRegions:regions,ensureBot:async()=>{},inPlayWorld:()=>true,stop:()=>{},tools:{unfinished:()=>false},providerForSlot:()=>({kind:'anthropic'})}
    objectives[worker]=await new SurvivalObjectives({rootDirectory:root,manager,world:{mumbaiAgentBounds:{min:{x:0,y:0,z:0},max:{x:100,y:200,z:100}}},api,
      modelCall:async()=>{throw Error('MODEL_MUST_NOT_SELECT_EXACT_CONTRACT_STEPS')},
      toolsFactory:({guard,job})=>({observe:async()=>({inventory:stock.agents[name]}),execute:async step=>{
        await guard();orders.authorizeStep(job,step)
        const stage=orders.owned(job.workOrder.orderId,owner).spec.stages[job.workOrder.stage],chests=job.lastObservation.workOrderChests
        assert.deepEqual(chests.source,stock.containers[stage.source.slot][stage.source.role])
        assert.deepEqual(chests.destination,stock.containers[stage.destination.slot][stage.destination.role])
        assert(Number.isSafeInteger(chests.observedAtMs))
        assert.throws(()=>orders.guard({...job,workOrder:{...job.workOrder,fence:'wrong'}}),/CLAIM_NOT_ACTIVE/)
        assert.throws(()=>orders.authorizeStep(job,{tool:'purchase',item:'stick',count:4}),/STEP_NOT_AUTHORIZED/)
        assert.throws(()=>orders.authorizeStep(job,{tool:'deposit',item:'diamond',count:1,position:stage.destination.position}),/STEP_NOT_AUTHORIZED/)
        const inventory=stock.agents[name]
        let result
        if(step.tool==='craft'){inventory.oak_planks-=2;inventory.stick+=4;result={item:'stick',produced:4}}
        else{const box=Object.values(stock.containers).flatMap(Object.values).find(b=>String(b.position)===String(step.position));const n=step.tool==='withdraw'?step.count:-step.count;box.items[step.item]-=n;inventory[step.item]+=n;result={item:step.item,moved:step.count}}
        job.effects.push({action:step.tool,...step,result})
        if(step.tool==='withdraw')assert.equal(orders.nextStep(job).tool,job.workOrder.stage===1?'craft':'deposit')
        return result
      }})}).initialize()
    objectives[worker].workOrders=orders
  }
  const createEvent=event()
  await orders.create({worker:'claude',event:createEvent,kind:'craft_delivery',item:'stick',count:4,objectives})
  const order=orders.state.orders[0]
  await orders.create({worker:'claude',event:createEvent,kind:'craft_delivery',item:'stick',count:4,objectives});assert.equal(orders.state.orders.length,1)
  assert(!JSON.stringify(publications).includes(owner));assert(!JSON.stringify(publications).includes(player));assert(!JSON.stringify(publications).includes(connectionId))
  await assert.rejects(orders.claim({worker:'claude',event:{...event(),playerId:randomUUID()},id:order.id,objectives}),/OWNER_REQUIRED/)
  await assert.rejects(orders.claim({worker:'0g',event:event(),id:order.id,objectives}),/OTHER_WORKER_REQUIRED/)
  const claimEvent=event();await orders.claim({worker:'claude',event:claimEvent,id:order.id,objectives});await objectives.claude.running.get(owner)
  assert.equal(order.status,'awaiting_handoff');assert.equal(order.verifications.length,1);assert.equal(objectives.claude.latest(owner).status,'ready_for_review')
  const source=objectives.claude.latest(owner)
  assert.throws(()=>orders.authorizeStep({...source,workOrder:{...source.workOrder,fence:'wrong'}},{tool:'purchase',item:'stick',count:4}),/CLAIM_NOT_ACTIVE/)
  const effects=source.effects.length
  await orders.claim({worker:'claude',event:claimEvent,id:order.id,objectives});assert.equal(source.effects.length,effects)
  assert.match(await orders.discover(event()),/next 0g/)
  assert.equal((await orders.verify(source)).verified,true)
  await orders.claim({worker:'0g',event:event(),id:order.id,objectives});await objectives['0g'].running.get(owner)
  assert.equal(order.status,'completed');assert.equal(order.verifications.length,2);assert.equal(stock.containers.CityAgent4.destinationChest.items.stick,4)
  assert.equal(objectives['0g'].latest(owner).history.length,3);assert.equal(reads,2)
  const context=objectives['0g'].latest(owner).sharedProgress
  assert.equal(context.facts.remainingStage,1);assert.equal(context.facts.verifiedStages.length,1)
  assert(!JSON.stringify(context).includes(source.workOrder.fence))
  assert(publications.some(r=>r.status==='awaiting_handoff'));assert.equal(publications.at(-1).status,'completed')
  console.log('PASS structured Arkiv reads drive only remaining stages; exact receipts, chest and inventory conservation verify both stages; private owner/fence and immutable retry guards')

  const e=event();failPublication=true
  await orders.create({worker:'claude',event:e,kind:'delivery',item:'oak_planks',count:2,objectives})
  const pending=orders.state.orders.at(-1);assert(pending.pendingPublication)
  await assert.rejects(orders.claim({worker:'claude',event:event(),id:pending.id,objectives}),/PUBLICATION_MUST_CONFIRM/)
  failPublication=false;await orders.retryPublications();assert.equal(pending.pendingPublication,null)
  const oldDeadline=pending.spec.deadline;pending.spec.deadline=Date.now()-1
  await assert.rejects(orders.claim({worker:'claude',event:event(),id:pending.id,objectives}),/DEADLINE_EXPIRED/);pending.spec.deadline=oldDeadline
  await orders.cancel(event(),pending.id,objectives);assert.equal(pending.status,'cancelled')
  objectives.claude.latest(owner).pendingEffect={action:'withdraw'}
  await assert.rejects(orders.create({worker:'claude',event:event(),kind:'delivery',item:'oak_planks',count:2,objectives}),/UNCERTAIN_EFFECT_BLOCKS_CLAIM/)
  objectives.claude.latest(owner).pendingEffect=null
  await orders.create({worker:'claude',event:event(),kind:'delivery',item:'oak_planks',count:2,objectives})
  const unverified=orders.state.orders.at(-1),originalFactory=objectives.claude.toolsFactory
  objectives.claude.toolsFactory=options=>{
    const tools=originalFactory(options),execute=tools.execute
    tools.execute=async step=>{const result=await execute(step);if(step.tool==='deposit')stock.containers.CityAgent4.sourceChest.items.oak_planks--;return result};return tools
  }
  await orders.claim({worker:'claude',event:event(),id:unverified.id,objectives});await objectives.claude.running.get(owner)
  assert.equal(unverified.status,'paused');assert.equal(unverified.verifications.length,0)
  assert.equal(objectives.claude.latest(owner).effects.length,2)
  await orders.cancel(event(),unverified.id,objectives)
  console.log('PASS exact work-order skill needs no model, resumes from receipts and never repeats effects when native counts disagree')
  console.log('PASS publication recovery, expired claims and cancellation preserve physical effects without payments')

  const rec=publications[0],key='0x'+'ab'.repeat(32),transactionHash='0x'+'cd'.repeat(32)
  const row={...Object.fromEntries(['server','kind','item','status'].map(k=>[k,{value:rec[k]}])),orderId:{value:rec.order},stage:{value:0n},deadline:{value:BigInt(rec.deadline)},data:{value:stringToHex(JSON.stringify(rec.data))},revision:{value:1n},$key:key,$owner:publisherAddress,$expiresAt:12345n}
  const progress={server,publisher:publisherAddress,client:{getEntity:async()=>row},get:async()=>{const e=Error();e.name='SchemaMismatchError';throw e}}
  const composed=withWorkOrders(progress,validateProgress);assert.equal((await composed.get(key)).order,rec.order)
  let broadcasts=0
  composed.client.getTransactionReceipt=async()=>({status:'success',logs:[{address:engineAddress,topics:encodeEventTopics({abi:ENTITY_EVENTS_ABI,eventName:'EntityCreated',args:{entityKey:key,owner:publisherAddress}}),data:encodeAbiParameters([{type:'uint64'},{type:'uint8'}],[12345n,1])}]})
  composed.client.request=async()=>{broadcasts++}
  const entry={fingerprint:createHash('sha256').update(JSON.stringify(rec)).digest('hex'),record:rec,revision:1,status:'submitted',rawTransaction:'0xdead',transactionHash,reservedCost:'100'}
  const recovered=new TaskPublisher({reader:composed,file:join(root,'publisher.json'),state:{version:1,server,publisher:publisherAddress,entries:[entry]}})
  assert.equal((await recovered.publish(rec)).entityKey,key);await recovered.publish(rec);assert.equal(broadcasts,0);assert.equal(entry.status,'confirmed')
  console.log('PASS real SDK work-order schema, mixed entity reads and shared publisher receipt recovery; no duplicate broadcast')
}finally{await Promise.allSettled(Object.values(objectives).map(o=>o.close()));await rm(root,{recursive:true,force:true})}
