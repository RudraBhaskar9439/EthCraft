import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import checkpoints from '../bot/checkpoint-store.cjs'
import {makeWorkSpec,validateWorkRecord,workDigest,workerSlots,recipes} from './work-order-schema.mjs'

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const totals=(job,action,item,position)=>job.effects.filter(e=>e.action===action&&e.item===item&&(!position||same(e.position,position))).reduce((n,e)=>n+(action==='craft'?e.result?.produced||0:e.count||0),0)
const amount=(observation,box,item)=>observation.containers?.[box.slot]?.[box.role]?.items?.[item]
const safeError=e=>/^[A-Z0-9_]+$/.test(e.message||'')?e.message:'WORK_ORDER_UNAVAILABLE'

export class WorkOrders {
  constructor({rootDirectory,reader,publisher,api,serverId,regions}){
    Object.assign(this,{reader,publisher,api,serverId,regions});this.file=join(rootDirectory,'.local/arkiv/work-orders.json');this.state={version:1,server:reader.server,orders:[],actions:{}};this.tail=Promise.resolve()
  }
  async initialize(){
    try{this.state=JSON.parse(await readFile(this.file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(this.state.version!==1||this.state.server!==this.reader.server||!Array.isArray(this.state.orders)||!this.state.actions)throw Error('WORK_ORDER_JOURNAL_BINDING_CHANGED')
    for(const order of this.state.orders)if(order.status==='working'){order.status='paused';order.pendingPublication=this.snapshot(order)}
    await this.save();return this
  }
  lock(fn){const work=this.tail.then(fn);this.tail=work.catch(()=>{});return work}
  save(){return checkpoints.writeCheckpoint(this.file,this.state)}
  owned(id,owner){const o=this.state.orders.find(o=>o.id===id&&o.ownerId===owner);if(!o)throw Error('WORK_ORDER_OWNER_REQUIRED');return o}
  snapshot(order){return validateWorkRecord({recordType:'work-order',server:this.reader.server,order:order.id,kind:order.spec.kind,item:order.spec.item,status:order.status,stage:order.verifications.length,deadline:order.spec.deadline,data:{version:1,spec:order.spec,specDigest:order.specDigest,verifications:order.verifications,claim:order.status==='working'?{worker:order.spec.stages[order.verifications.length].worker,stage:order.verifications.length,expiresAt:order.spec.deadline}:null,fixture:order.fixture===true}},this.reader.server)}
  async publish(order){
    const record=this.snapshot(order);order.pendingPublication=record;await this.save()
    try{const result=await this.publisher.publish(record);order.entityKey=result.entityKey;order.transactionHash=result.transactionHash;order.pendingPublication=null;order.publicationError=null;await this.save();return result}
    catch(error){order.publicationError=safeError(error);await this.save();return null}
  }
  async retryPublications(){return this.lock(async()=>{for(const order of this.state.orders)if(order.pendingPublication)await this.publish(order)})}
  async observation(event,spec){
    const items=[...new Set([spec.input.item,spec.item])]
    const observed=await this.api('work-observe',{playerId:event.actorPlayerId,connectionId:event.connectionId,ownerId:event.playerId,items})
    if(observed.version!==1||observed.serverId!==this.serverId||!Number.isSafeInteger(observed.observedAtMs)||Math.abs(Date.now()-observed.observedAtMs)>15000||typeof observed.worldUuid!=='string')throw Error('WORK_ORDER_NATIVE_OBSERVATION_REQUIRED')
    for(const stage of spec.stages)for(const box of [stage.source,stage.destination]){
      const actual=observed.containers?.[box.slot]?.[box.role]
      if(!same(actual?.position,box.position)||items.some(item=>!Number.isSafeInteger(actual.items?.[item])||actual.items[item]<0))throw Error('WORK_ORDER_NATIVE_CHEST_BINDING_CHANGED')
    }
    for(const slot of Object.values(workerSlots))if(items.some(item=>!Number.isSafeInteger(observed.agents?.[slot]?.[item])||observed.agents[slot][item]<0))throw Error('WORK_ORDER_NATIVE_AGENT_OBSERVATION_REQUIRED')
    return observed
  }
  assertAgents(objectives,event){
    for(const [worker,slotName]of Object.entries(workerSlots)){
      const manager=objectives[worker]?.manager,slot=manager?.slots.find(s=>s.name===slotName&&s.ownerId===event.playerId&&s.minecraftPlayerId===event.actorPlayerId)
      if(!slot||!slot.bot||!manager.inPlayWorld(slot))throw Error('WORK_ORDER_BOTH_OWNED_AGENTS_REQUIRED')
      const job=objectives[worker].latest(event.playerId)
      if(job?.pendingEffect||job?.activeLock||manager.tools.unfinished(event.playerId))throw Error('WORK_ORDER_UNCERTAIN_EFFECT_BLOCKS_CLAIM')
      if(objectives[worker].running.has(event.playerId)||job?.status==='running')throw Error('WORK_ORDER_AGENT_MUST_BE_IDLE')
    }
  }
  async create({worker,event,kind,item,count,objectives}){
    return this.lock(async()=>{
      const old=this.state.actions[event.operationId]
      if(old)return this.summary(this.owned(old.order,event.playerId))
      this.assertAgents(objectives,event)
      if(this.state.orders.some(o=>o.ownerId===event.playerId&&!['completed','cancelled'].includes(o.status)&&o.spec.deadline>Date.now()))throw Error('WORK_ORDER_FINISH_OR_CANCEL_EXISTING_ORDER')
      const spec=makeWorkSpec({id:randomUUID(),kind,item,count,worker,regions:this.regions})
      await this.observation(event,spec)
      const order={id:spec.id,ownerId:event.playerId,playerId:event.actorPlayerId,spec,specDigest:workDigest(spec),status:'open',verifications:[],active:null,createdFrom:event.operationId}
      this.state.orders.push(order);this.state.actions[event.operationId]={order:order.id,action:'create'};await this.save();await this.publish(order)
      return this.summary(order)+' Public structured task, material quantities and chest positions were published. Use /agent '+(worker==='claude'?'agent':'0g')+' order claim '+order.id
    })
  }
  summary(order){return 'Order '+order.id+': '+order.status+', '+order.verifications.length+'/2 server-checked stages; '+order.spec.count+' '+order.spec.item+'.'+(order.publicationError?' Arkiv publication waiting: '+order.publicationError+'.':'')}
  async discover(event){
    const page=await this.reader.orders.list(),owned=new Set(this.state.orders.filter(o=>o.ownerId===event.playerId).map(o=>o.id))
    return page.records.filter(r=>owned.has(r.order)&&r.deadline>Date.now()&&!['completed','cancelled'].includes(r.status)).map(r=>r.order+' '+r.kind+' '+r.data.spec.count+' '+r.item+'; next '+(r.data.spec.stages[r.stage]?.worker||'none')+'; '+r.status).join('\n')||'No unexpired approved work orders found on Arkiv.'
  }
  stageGoal(spec,index){
    const s=spec.stages[index],where=box=>'['+box.position.join(', ')+']'
    if(index===0)return 'Supply stage only: withdraw exactly '+s.count+' '+s.item+' from your source chest '+where(s.source)+', then deposit exactly '+s.count+' into the other owned agent source chest '+where(s.destination)+'. Do not craft or perform the next stage. Use only move, observe, withdraw and deposit.'
    return 'Finish the remaining order stage: withdraw exactly '+spec.input.count+' '+spec.input.item+' from your source chest '+where(s.source)+', '+(s.action==='craft_delivery'?'craft exactly '+s.count+' '+s.item+', then ':'then ')+'deposit exactly '+s.count+' '+s.item+' into your destination chest '+where(s.destination)+'. Use only move, observe, withdraw, '+(s.action==='craft_delivery'?'craft, ':'')+'and deposit. Prior supply-stage work is already verified; do not repeat it.'
  }
  async claim({worker,event,id,objectives}){
    return this.lock(async()=>{
      const prior=this.state.actions[event.operationId]
      if(prior)return this.summary(this.owned(prior.order,event.playerId))
      const order=this.owned(id,event.playerId)
      if(order.spec.deadline<=Date.now())throw Error('WORK_ORDER_DEADLINE_EXPIRED')
      if(['completed','cancelled'].includes(order.status))return this.summary(order)
      if(this.state.orders.some(o=>o.ownerId===event.playerId&&o.id!==id&&o.active))throw Error('WORK_ORDER_ANOTHER_CLAIM_IS_ACTIVE')
      const native=objectives[worker],index=order.verifications.length
      if(!native||order.spec.stages[index].worker!==worker)throw Error('WORK_ORDER_OTHER_WORKER_REQUIRED')
      if(order.active){
        const job=native.state.jobs.find(j=>j.operationId===order.active.operationId&&j.ownerId===event.playerId)
        if(!job||job.pendingEffect||job.activeLock)throw Error('WORK_ORDER_RECONCILIATION_REQUIRED')
        if(native.running.has(event.playerId))return this.summary(order)
        if(job.status!=='paused')throw Error('WORK_ORDER_STAGE_STATE_REQUIRES_REVIEW')
        order.status='working';await this.save()
        const result=await native.start(event,'resume')
        if(job.status!=='running'){order.status='paused';await this.save();throw Error('WORK_ORDER_STAGE_NOT_STARTED')}
        this.state.actions[event.operationId]={order:id,action:'resume',stage:index};await this.save();await this.publish(order);return result
      }
      this.assertAgents(objectives,event)
      // The executable stage is derived from a fresh Arkiv read, pinned to the owner's original approved spec.
      await this.publish(order)
      if(order.pendingPublication||!order.entityKey)throw Error('WORK_ORDER_PUBLICATION_MUST_CONFIRM')
      const record=await this.reader.orders.get(order.entityKey)
      if(record.order!==id||record.data.specDigest!==order.specDigest||workDigest(record.data.spec)!==order.specDigest||record.stage!==index||!same(record.data.verifications,order.verifications))throw Error('WORK_ORDER_ARKIV_STATE_CHANGED')
      const spec=record.data.spec,baseline=await this.observation(event,spec)
      const stage=spec.stages[index]
      if(amount(baseline,stage.source,spec.input.item)<spec.input.count)throw Error('WORK_ORDER_SUPPLIES_NOT_AVAILABLE')
      const fence=randomUUID(),operationId='work-order:'+id+':'+index
      order.active={worker,stage:index,fence,operationId,baseline};order.status='working';this.state.actions[event.operationId]={order:id,action:'claim',stage:index};await this.save()
      const context={entityKey:record.entityKey,rootTask:id,provider:worker,facts:{workOrder:spec,verifiedStages:record.data.verifications,remainingStage:index}}
      const assignment={orderId:id,stage:index,fence,specDigest:order.specDigest}
      let result
      try{
        result=await native.start({...event,operationId},this.stageGoal(spec,index),context,assignment)
        const job=native.state.jobs.find(j=>j.operationId===operationId&&j.ownerId===event.playerId)
        if(!job||job.workOrder?.fence!==fence){order.active=null;order.status='paused';await this.save();throw Error('WORK_ORDER_STAGE_NOT_STARTED')}
      }catch(error){order.status='paused';await this.save();await this.publish(order);throw error}
      await this.publish(order)
      return result+' Stage '+(index+1)+'/2 was read from Arkiv; server inventory checks decide completion.'
    })
  }
  guard(job){
    if(!job.workOrder)return
    const o=this.owned(job.workOrder.orderId,job.ownerId),a=o.active
    if(o.status!=='working'||o.spec.deadline<=Date.now()||!a||a.fence!==job.workOrder.fence||a.stage!==job.workOrder.stage||a.operationId!==job.operationId||o.specDigest!==job.workOrder.specDigest)throw Error('WORK_ORDER_CLAIM_NOT_ACTIVE')
  }
  nextStep(job){
    this.guard(job)
    if(job.pendingEffect)throw Error('WORK_ORDER_RECONCILIATION_REQUIRED')
    const order=this.owned(job.workOrder.orderId,job.ownerId),stage=order.spec.stages[job.workOrder.stage],input=order.spec.input
    const missingInput=input.count-totals(job,'withdraw',input.item,stage.source.position)
    if(missingInput>0)return{tool:'withdraw',item:input.item,count:missingInput,position:stage.source.position}
    const missingOutput=stage.count-totals(job,'craft',stage.item)
    if(stage.action==='craft_delivery'&&missingOutput>0)return{tool:'craft',item:stage.item,count:missingOutput}
    const missingDelivery=stage.count-totals(job,'deposit',stage.item,stage.destination.position)
    if(missingDelivery>0)return{tool:'deposit',item:stage.item,count:missingDelivery,position:stage.destination.position}
    return null
  }
  authorizeStep(job,step){
    if(!job.workOrder)return
    this.guard(job)
    const order=this.owned(job.workOrder.orderId,job.ownerId),index=job.workOrder.stage,s=order.spec.stages[index]
    if(step.tool==='observe')return
    if(step.tool==='move'){
      if(![s.source,s.destination].some(c=>Math.hypot(step.position[0]-c.position[0],step.position[2]-c.position[2])<=6&&Math.abs(step.position[1]-c.position[1])<=4))throw Error('WORK_ORDER_MOVE_OUTSIDE_STAGE')
      return
    }
    if(step.tool==='withdraw'&&step.item===order.spec.input.item&&same(step.position,s.source.position)&&totals(job,'withdraw',step.item,step.position)+step.count<=order.spec.input.count)return
    if(step.tool==='deposit'&&step.item===s.item&&same(step.position,s.destination.position)&&totals(job,'deposit',step.item,step.position)+step.count<=s.count)return
    if(step.tool==='craft'&&index===1&&s.action==='craft_delivery'&&step.item===s.item){
      const output=Math.ceil(step.count/recipes[s.item].output)*recipes[s.item].output
      if(totals(job,'craft',s.item)+output<=s.count)return
    }
    throw Error('WORK_ORDER_STEP_NOT_AUTHORIZED')
  }
  async verify(job){
    if(!job.workOrder)return null
    return this.lock(async()=>{
      const order=this.owned(job.workOrder.orderId,job.ownerId),index=job.workOrder.stage
      const result=proof=>({verified:true,proof,orderId:order.id,completed:index===1,nextWorker:order.spec.stages[index+1]?.worker,publicationPending:!!order.pendingPublication})
      const known=order.verifications[index]
      if(known?.job===job.id)return result(known)
      this.guard(job)
      const a=order.active,s=order.spec.stages[index],input=order.spec.input
      if(job.pendingEffect||totals(job,'withdraw',input.item,s.source.position)!==input.count||totals(job,'deposit',s.item,s.destination.position)!==s.count||s.action==='craft_delivery'&&totals(job,'craft',s.item)!==s.count)return{verified:false}
      const after=await this.observation({actorPlayerId:job.playerId,connectionId:job.connectionId,playerId:job.ownerId},order.spec),before=a.baseline
      if(after.worldUuid!==before.worldUuid||after.observedAtMs<before.observedAtMs)throw Error('WORK_ORDER_WORLD_OBSERVATION_CHANGED')
      const sourceBefore=amount(before,s.source,input.item),sourceAfter=amount(after,s.source,input.item),destinationBefore=amount(before,s.destination,s.item),destinationAfter=amount(after,s.destination,s.item)
      if(sourceBefore-sourceAfter!==input.count||destinationAfter-destinationBefore!==s.count)return{verified:false,reason:'Native chest quantities do not match the authorized stage.'}
      for(const slot of Object.values(workerSlots))for(const item of [input.item,s.item])if(after.agents[slot][item]!==before.agents[slot][item])return{verified:false,reason:'Agent inventory has not returned to its stage baseline.'}
      const proof={stage:index,worker:s.worker,item:s.item,count:s.count,job:job.id,observedAt:after.observedAtMs,worldUuid:after.worldUuid,evidenceDigest:workDigest({before,after}),receiptDigest:workDigest(job.effects),sourceBefore,sourceAfter,destinationBefore,destinationAfter}
      order.verifications.push(proof);order.active=null;order.status=index===1?'completed':'awaiting_handoff';await this.save();await this.publish(order)
      return result(proof)
    })
  }
  async syncStatus(job){
    if(!job?.workOrder||job.status==='running')return
    return this.lock(async()=>{
      const order=this.owned(job.workOrder.orderId,job.ownerId)
      if(order.active?.fence!==job.workOrder.fence)return
      const status=job.pendingEffect?'reconciliation_required':'paused'
      if(order.status!==status){order.status=status;await this.save();await this.publish(order)}
    })
  }
  async cancel(event,id,objectives){
    const order=this.owned(id,event.playerId)
    if(order.active){const o=objectives[order.active.worker];await o.stop(event.playerId);await o.running.get(event.playerId);const job=o.latest(event.playerId);if(job?.pendingEffect||job?.activeLock)throw Error('WORK_ORDER_UNCERTAIN_EFFECT_BLOCKS_CANCEL')}
    return this.lock(async()=>{order.active=null;order.status='cancelled';await this.save();await this.publish(order);return this.summary(order)})
  }
  async command(worker,event,text,objectives){
    const parts=text.trim().split(/\s+/),action=parts.shift()
    if(action==='create'&&parts.length===3)return this.create({worker,event,kind:parts[0],item:parts[1],count:Number(parts[2]),objectives})
    if(action==='discover'&&!parts.length)return this.discover(event)
    if(action==='claim'&&parts.length===1)return this.claim({worker,event,id:parts[0],objectives})
    if(action==='status'&&parts.length===1)return this.summary(this.owned(parts[0],event.playerId))
    if(action==='cancel'&&parts.length===1)return this.cancel(event,parts[0],objectives)
    return 'Use order create delivery <item> <count>, order create craft_delivery stick <multiple of 4>, order discover, order claim <id>, order status <id> or order cancel <id>. These publish structured public tasks; they do not authorize CITY payments.'
  }
}
