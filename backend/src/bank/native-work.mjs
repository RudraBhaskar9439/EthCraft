import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { keccak256, stringToHex, parseUnits } from 'viem'
import { createAgentManager, PERSONAL_AGENT_NAMES } from '../playable/agents.mjs'
import { compileTaskPlan, NativeTaskAdapter } from '../playable/task-tools.mjs'
import { digest, json, stable, lower, hex32 } from '../world-assets/canonical.mjs'
import { createBankReader } from './canonical.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const PLAN={action:'build_platform',width:2,depth:2,material:'oak_planks'}
const fail=code=>{throw Object.assign(Error(code),{code})}
const air=name=>['air','cave_air','void_air'].includes(name)

/** Funded fixed work uses the existing native tools and their material receipts, without inference. */
export async function createBankNativeWork({rootDirectory,manifest,wallets,native,resolveIdentity,store,client,abis,runtimeDirectory}={}){
 const active=JSON.parse(await readFile(join(rootDirectory,'.local/playable-world/active.json'),'utf8'))
 if(active.owner!=='agentcity-playable-pilot'||active.deploymentOwner!=='agentcity-laptop-bank'||resolve(active.runtime)!==resolve(runtimeDirectory||active.runtime)
  ||keccak256(stringToHex(active.serverId))!==manifest.serverId)fail('BANK_NATIVE_NAMESPACE_REQUIRED')
 runtimeDirectory=active.runtime
 const reader=createBankReader({client,manifest,abis}),guards=new Map()
 await reader.verify()
 let managerPromise,closed=false
 const get=id=>store.get(manifest.deploymentId,'bank-native-work:'+id)
 const put=book=>store.put(manifest.deploymentId,'bank-native-work:'+book.workId,json(book))
 const lock=(id,work)=>store.lock(manifest.deploymentId,'bank-native-work:'+id,work)
 const requireId=id=>{if(!hex32(id))fail('BANK_NATIVE_WORK_ID_REQUIRED');return id.toLowerCase()}

 async function identity(principalId){
  if(!UUID.test(principalId||''))fail('BANK_NATIVE_IDENTITY_REQUIRED')
  const value=await resolveIdentity({principalId}),configured=Object.values(wallets.settings?.actors||{}).find(actor=>actor.principalId===principalId)
  if(!configured||value?.principalId!==principalId||value.operatorControlled!==true||lower(value.walletAddress)!==lower(configured.wallet.address)
   ||value.ownerPrincipalId!==configured.ownerPrincipalId)fail('BANK_NATIVE_OPERATOR_BINDING_REQUIRED')
  return value
 }
 async function owner(book){
  const worker=await identity(book.workerId),value=await identity(book.ownerPrincipalId)
  if(worker.ownerPrincipalId!==value.principalId||lower(worker.walletAddress)!==book.workerWallet||value.minecraftPlayerId!==book.ownerPlayerId
   ||value.minecraftUsername!==book.ownerName)fail('BANK_NATIVE_WORKER_OWNER_CHANGED')
  const session=await native('session?playerId='+value.minecraftPlayerId)
  if(session.online!==true||session.pendingAuthentication!==false||session.principalId!==value.principalId||session.authenticationKind!=='discord_approved_local_profile')fail('BANK_NATIVE_OWNER_CONNECTION_REQUIRED')
  return value
 }
 async function booking(id){const book=await get(requireId(id));if(!book)fail('BANK_NATIVE_BOOKING_REQUIRED');return book}
 async function caller(book,principalId){
  const expected=principalId===book.requesterId?book.requesterWallet:principalId===book.workerId?book.workerWallet:null
  if(!expected||lower((await identity(principalId)).walletAddress)!==expected)fail('BANK_NATIVE_WORK_ACTOR_REQUIRED')
 }
 async function chain(book){
  const block=await reader.snapshot(book.chainAnchor),work=await client.readContract({address:manifest.workEscrow,abi:abis.workEscrow,functionName:'work',args:[book.workId],blockNumber:BigInt(block.blockNumber)})
  if(Number(work.state)===0||lower(work.requester)!==book.requesterWallet||lower(work.worker)!==book.workerWallet
   ||work.termsHash.toLowerCase()!==book.termsHash||String(work.amount)!==book.amountBaseUnits)fail('BANK_NATIVE_FUNDED_TERMS_CHANGED')
  await reader.unchanged(block)
  book.chainAnchor=json(block);await put(book)
  return{work,block}
 }
 async function manager(){
  if(closed)fail('BANK_NATIVE_WORK_CLOSED')
  if(!managerPromise)managerPromise=(async()=>{
   const world=await native('status'),properties=await native('property/status',{})
   if(world.available!==true||properties.serverNamespace!==active.serverId)fail('BANK_NATIVE_WORLD_UNAVAILABLE')
   const instance=await createAgentManager({rootDirectory,runtimeDirectory,gamePort:25596,movementBounds:world.taskBounds,taskRegions:world.taskRegions,
    playWorld:world.playWorld,playSpawn:world.playSpawn,
    planner:async()=>fail('BANK_NATIVE_FIXED_PLAN_ONLY'),intentModelCall:async()=>fail('BANK_NATIVE_INFERENCE_DISABLED'),
    onTaskResult:async()=>{},onTaskLock:async(slot,task,state)=>{
     const books=await store.list(manifest.deploymentId,'bank-native-work:'),book=books.find(value=>value.operationId===task.operationId)
     if(!book||slot.ownerId!==book.ownerPrincipalId||slot.name!==book.slotName)fail('BANK_NATIVE_TASK_BINDING_REQUIRED')
     book.taskId=task.id;await put(book)
     if(state.locked){
      const{work,block}=await chain(book)
      if(Number(work.state)!==2||block.timestamp>=Number(work.deadline))fail('BANK_NATIVE_RUNNING_WORK_REQUIRED')
      await owner(book)
      await native('task-lock',{slotName:slot.name,taskId:task.id,ownerId:slot.ownerId,ownerPlayerId:book.ownerPlayerId,locked:true})
      book.nativeLocked=true;await put(book)
     }
     // The generic tools finish here. Funded work keeps protection through review and settlement.
    }})
   const originalReady=instance.tools.ownerReady
   instance.tools.ownerReady=slot=>originalReady(slot)&&Boolean(guards.get(slot.ownerId)?.deadline>Date.now())
   return instance
  })().catch(error=>{managerPromise=null;throw error})
  return managerPromise
 }
 async function slotFor(book){
  const value=await owner(book),instance=await manager()
  let slot=instance.slots.find(slot=>slot.ownerId===value.principalId)
  if(!slot){
   await instance.handle({operationId:'bank-create-'+value.principalId,playerId:value.principalId,actorPlayerId:value.minecraftPlayerId,
    playerName:value.minecraftUsername,action:'create',args:'',createdAtMs:Date.now()})
   slot=instance.slots.find(slot=>slot.ownerId===value.principalId)
  }
  if(!slot||slot.name!==book.slotName||slot.ownerName!==book.ownerName||slot.minecraftPlayerId!==book.ownerPlayerId)fail('BANK_NATIVE_AGENT_BINDING_CHANGED')
  await instance.ensureBot(slot)
  const region=instance.tools.region(slot)
  if(digest({region,plan:compileTaskPlan(book.plan,region)})!==book.regionDigest)fail('BANK_NATIVE_REGISTERED_REGION_CHANGED')
  return{instance,slot}
 }
 async function protectedResult(book){
  const{instance,slot}=await slotFor(book),task=instance.tools.state.tasks.find(value=>value.operationId===book.operationId)
  if(!task||task.status!=='complete'||task.pending||task.completed.length!==4||task.preexisting.length!==0||task.ownerId!==book.ownerPrincipalId
   ||task.slotName!==book.slotName||stable(task.plan)!==stable(book.compiledPlan))fail('BANK_NATIVE_ACTUAL_RESULT_REQUIRED')
  const locks=JSON.parse(await readFile(join(runtimeDirectory,'plugins/AgentCity/task-region-locks.json'),'utf8'))
  if(locks[slot.name]?.taskId!==task.id||locks[slot.name]?.ownerId!==book.ownerPrincipalId)fail('BANK_NATIVE_RESULT_PROTECTION_REQUIRED')
  const require=createRequire(import.meta.url),{Vec3}=require(join(rootDirectory,'tests/compatibility/node_modules/vec3'))
  for(let i=0;i<task.plan.placements.length;i++){
   const placement=task.plan.placements[i],receipt=task.receipts[book.operationId+':place:'+i]
   if(!receipt||!air(receipt.before.block)||receipt.after.block!=='oak_planks'
    ||Number(receipt.before.inventory.oak_planks||0)-Number(receipt.after.inventory.oak_planks||0)!==1
    ||slot.bot.blockAt(new Vec3(...placement.position))?.name!=='oak_planks')fail('BANK_NATIVE_BLOCK_AND_MATERIAL_PROOF_REQUIRED')
  }
  const result={schema:'agentcity.bank-native-result.v1',deploymentId:manifest.deploymentId,serverId:manifest.serverId,
   workId:book.workId,termsHash:book.termsHash,taskId:task.id,ownerPrincipalId:book.ownerPrincipalId,slotName:slot.name,
   plan:task.plan,planHash:task.planHash,placements:4,material:'oak_planks',consumed:4,receipts:task.receipts}
  return{result,resultHash:'0x'+digest(result),taskId:task.id}
 }

 async function inspectNewWork(book,region,world){
  return store.lock(manifest.deploymentId,'bank-native-inspect:'+book.ownerPrincipalId,async()=>{
  const {instance,slot}=await slotFor(book)
  if(instance.tools.unfinished(book.ownerPrincipalId)||instance.tools.inspecting.has(book.ownerPrincipalId))fail('BANK_NATIVE_AGENT_BUSY')
  const key='bank-native-inspection:'+book.ownerPrincipalId
  const previous=await store.get(manifest.deploymentId,key)
  const release=async inspection=>{
   await native('task-lock',{...inspection,locked:false})
   await native('remote-grant',{...inspection,revoked:true})
   await store.put(manifest.deploymentId,key,{...inspection,state:'released'})
  }
  if(previous&&previous.state!=='released')await release(previous)
  const inspection={grantId:randomUUID(),taskId:randomUUID(),slotName:slot.name,ownerId:book.ownerPrincipalId,
   generation:1,expiresAtMs:Date.now()+60000,tools:['inspect'],state:'opening'}
  await store.put(manifest.deploymentId,key,inspection)
  const generation=slot.generation
  let renewalFailure,renewal=Promise.resolve(),timer
  const check=()=>{
   if(renewalFailure)fail('BANK_NATIVE_INSPECTION_LEASE_UNAVAILABLE')
   if(!slot.bot||slot.generation!==generation||slot.bot._client.state!=='play')fail('BANK_NATIVE_AGENT_CONNECTION_REQUIRED')
  }
  const adapter=new NativeTaskAdapter({bot:slot.bot,rootDirectory,region,check,playSpawn:world.playSpawn})
  const footprint=()=>{
   check()
   for(const placement of book.compiledPlan.placements){
    if(!air(adapter.block(placement.position)))fail('BANK_NATIVE_NEW_FOOTPRINT_REQUIRED')
    const [x,y,z]=placement.position
    if(slot.bot.blockAt(new adapter.Vec3(x,y-1,z))?.boundingBox!=='block')fail('BANK_NATIVE_SUPPORTED_FOOTPRINT_REQUIRED')
   }
  }
  instance.tools.inspecting.add(book.ownerPrincipalId)
  try{
   footprint()
   const renew=()=>native('remote-grant',{...inspection,leaseExpiresAtMs:Math.min(inspection.expiresAtMs,Date.now()+5000)})
   await renew()
   await native('task-lock',{...inspection,remoteGrantId:inspection.grantId,tool:'inspect',locked:true})
   timer=setInterval(()=>{renewal=renewal.then(renew).catch(error=>{renewalFailure=error})},2000)
   const source=await adapter.chestCounts(region.sourceChest),inventory=adapter.inventory()
   const available=Number(source.oak_planks||0)+Number(inventory.oak_planks||0)
   if(available<book.compiledPlan.placements.length)fail('BANK_NATIVE_MATERIALS_REQUIRED_BEFORE_FUNDING')
   await owner(book);footprint()
   return{observedAt:new Date().toISOString(),source,inventory,availableOakPlanks:available,emptyPositions:book.compiledPlan.placements.map(value=>value.position)}
  }finally{
   clearInterval(timer)
   await renewal
   adapter.restore?.()
   instance.tools.inspecting.delete(book.ownerPrincipalId)
   await release(inspection)
  }
  })
 }

 async function prepare(input){
  const{sourceWorkId,requesterId,workerId,amount}=input,workId=requireId(input.workId),termsHash=String(input.termsHash||'').toLowerCase()
  if(!UUID.test(sourceWorkId||'')||keccak256(stringToHex(sourceWorkId))!==workId||stable(input.plan)!==stable(PLAN)
   ||typeof amount!=='string'||!hex32(termsHash)||termsHash!=='0x'+digest({sourceWorkId,requesterId,workerId,plan:input.plan,amount}))fail('BANK_NATIVE_EXACT_QUOTED_PLAN_REQUIRED')
  if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(amount))fail('BANK_NATIVE_WORK_PRICE_REQUIRED')
  const amountBaseUnits=String(parseUnits(amount,18))
  if(BigInt(amountBaseUnits)<=0n||BigInt(amountBaseUnits)>BigInt(manifest.maxCityAmountBaseUnits))fail('BANK_NATIVE_WORK_PRICE_REQUIRED')
  return lock(workId,async()=>{
   const requester=await identity(requesterId),worker=await identity(workerId)
   if(!worker.ownerPrincipalId||requester.walletAddress===worker.walletAddress)fail('BANK_NATIVE_DISTINCT_WORKER_REQUIRED')
   const workerOwner=await identity(worker.ownerPrincipalId)
   if(!UUID.test(workerOwner.minecraftPlayerId||'')||!/^[A-Za-z0-9_]{3,16}$/.test(workerOwner.minecraftUsername||''))fail('BANK_NATIVE_GAME_OWNER_REQUIRED')
   const fixed={sourceWorkId,workId,termsHash,requesterId,workerId,amount,amountBaseUnits,plan:json(input.plan),
    requesterWallet:lower(requester.walletAddress),workerWallet:lower(worker.walletAddress),ownerPrincipalId:workerOwner.principalId,
    ownerPlayerId:workerOwner.minecraftPlayerId,ownerName:workerOwner.minecraftUsername}
   const prior=await get(workId)
   if(prior){if(prior.bookingDigest!==digest(fixed))fail('BANK_NATIVE_BOOKING_IMMUTABLE');return json(prior)}
   const world=await native('status')
   let saved={agents:[]};try{saved=JSON.parse(await readFile(join(runtimeDirectory,'personal-agents.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
   const slotName=saved.agents.find(value=>value.ownerId===workerOwner.principalId)?.name||PERSONAL_AGENT_NAMES.find(name=>!saved.agents.some(value=>value.name===name))
   const region=world.taskRegions.find(value=>value.slotName===slotName)
   if(!region)fail('BANK_NATIVE_REGISTERED_AGENT_SLOT_REQUIRED')
   // shortcut: one paid platform at the registered origin; extend signed offsets before offering repeated builds there.
   const compiledPlan=compileTaskPlan(input.plan,region)
   const book={...fixed,bookingDigest:digest(fixed),slotName,compiledPlan,regionDigest:digest({region,plan:compiledPlan}),operationId:randomUUID(),state:'prepared'}
   book.preflight=await inspectNewWork(book,region,world)
   await put(book);return json(book)
  })
 }
 async function run({workId,principalId}){
  workId=requireId(workId)
  return lock(workId,async()=>{
   const book=await booking(workId)
   await caller(book,principalId)
   const{work,block}=await chain(book)
   if(Number(work.state)===4&&book.resultHash===work.resultHash)return{status:'accepted',workId,resultHash:book.resultHash}
   if(Number(work.state)===3&&book.resultHash===work.resultHash){const proof=await protectedResult(book);if(proof.resultHash!==book.resultHash)fail('BANK_NATIVE_RESULT_CHANGED');return{status:'completed',workId,resultHash:book.resultHash}}
   if(Number(work.state)!==2||block.timestamp>=Number(work.deadline))fail('BANK_NATIVE_RUNNING_WORK_REQUIRED')
   const{instance,slot}=await slotFor(book)
   let task=instance.tools.state.tasks.find(value=>value.operationId===book.operationId)
   if(!task){
    const require=createRequire(import.meta.url),{Vec3}=require(join(rootDirectory,'tests/compatibility/node_modules/vec3'))
    if(book.compiledPlan.placements.some(value=>!air(slot.bot.blockAt(new Vec3(...value.position))?.name)))fail('BANK_NATIVE_NEW_FOOTPRINT_REQUIRED')
   }
   guards.set(book.ownerPrincipalId,{workId,deadline:Number(work.deadline)*1000})
   try{await instance.tools.start({slot,plan:book.plan,operationId:book.operationId});await instance.tools.idle()}
   finally{guards.delete(book.ownerPrincipalId)}
   const proof=await protectedResult(book)
   const fresh=await booking(workId);fresh.state='native_complete';fresh.resultHash=proof.resultHash;fresh.result=proof.result;fresh.taskId=proof.taskId;await put(fresh)
   return{status:'native_complete',workId,termsHash:book.termsHash,resultHash:proof.resultHash,taskId:proof.taskId,placements:4,consumed:4}
  })
 }
 async function authorize({action,workId,termsHash,principalId,request,retainedProof}){
  workId=requireId(workId)
  return lock(workId,async()=>{
   const book=await booking(workId)
   if(termsHash!==book.termsHash)fail('BANK_NATIVE_INSPECTOR_TERMS_REQUIRED')
   await caller(book,principalId)
   const{work,block}=await chain(book)
   await owner(book)
   if(action==='workstart'){
    if(Number(work.state)!==1||block.timestamp>=Number(work.deadline))fail('BANK_NATIVE_FUNDED_START_REQUIRED')
    return{approved:true,workId,termsHash,bookingDigest:book.bookingDigest}
   }
   if(action!=='workcomplete'||Number(work.state)!==2||block.timestamp>=Number(work.deadline)||!book.resultHash)fail('BANK_NATIVE_COMPLETION_REQUIRED')
   const proof=await protectedResult(book)
   if(proof.resultHash!==book.resultHash||request?.resultHash&&request.resultHash!==proof.resultHash||retainedProof?.resultHash&&retainedProof.resultHash!==proof.resultHash)fail('BANK_NATIVE_FORGED_RESULT_REFUSED')
   return{approved:true,workId,termsHash,resultHash:proof.resultHash,bookingDigest:book.bookingDigest,taskId:proof.taskId}
  })
 }
 async function releaseIfSettled(workId){
  workId=requireId(workId)
  return lock(workId,async()=>{
   const book=await booking(workId),{work}=await chain(book)
   if(![4,5].includes(Number(work.state)))return{released:false,workId}
   if(Number(work.state)===4&&book.resultHash!==work.resultHash)fail('BANK_NATIVE_SETTLEMENT_RESULT_CHANGED')
   if(book.taskId){
    const instance=await manager(),task=instance.tools.state.tasks.find(value=>value.operationId===book.operationId)
    // A settled payment cannot discard unknown native effects; reconcile those before releasing protection.
    if(task?.pending||task&&instance.tools.running.has(task.id))fail('BANK_NATIVE_OPERATION_RECONCILIATION_REQUIRED')
    await native('task-lock',{slotName:book.slotName,taskId:book.taskId,ownerId:book.ownerPrincipalId,ownerPlayerId:book.ownerPlayerId,locked:false})
   }
   book.nativeLocked=false;book.state=Number(work.state)===4?'accepted':'refunded';await put(book)
   return{released:true,workId,state:book.state}
  })
 }
 return{prepare,run,authorize,releaseIfSettled,async close(){closed=true;if(managerPromise)await(await managerPromise).close()}}
}
