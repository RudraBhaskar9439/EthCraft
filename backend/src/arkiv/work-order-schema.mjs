import {defineSchema,str,u64,bytes} from '@arkiv-network/sdk-rabdi'
import {and,eq,desc} from '@arkiv-network/sdk-rabdi/query'
import {keccak256,stringToHex,hexToString} from 'viem'

export const WorkOrder=defineSchema('ethcraft.work-orders.v1',{server:str().indexed(),orderId:str().indexed(),kind:str().indexed(),item:str().indexed(),status:str().indexed(),stage:u64().indexed(),deadline:u64().indexed(),revision:u64().indexed(),data:bytes()})
export const workerSlots=Object.freeze({claude:'CityAgent5','0g':'CityAgent4'})
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,hash=/^0x[0-9a-f]{64}$/i,name=/^[a-z][a-z0-9_]{0,63}$/
const statuses=new Set(['open','working','awaiting_handoff','paused','reconciliation_required','completed','cancelled'])
export const recipes=Object.freeze({stick:{item:'oak_planks',input:2,output:4},oak_planks:{item:'oak_log',input:1,output:4},stone_bricks:{item:'stone',input:4,output:4}})
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k))
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value
export const workDigest=value=>keccak256(stringToHex(JSON.stringify(sorted(value))))
const integer=(n,max=100000)=>Number.isSafeInteger(n)&&n>=0&&n<=max
const position=p=>Array.isArray(p)&&p.length===3&&p.every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=30000000)
function chest(c){return keys(c,['slot','role','position'])&&Object.values(workerSlots).includes(c.slot)&&['sourceChest','destinationChest'].includes(c.role)&&position(c.position)}

export function validateWorkSpec(s){
  if(!keys(s,['version','id','kind','item','count','input','stages','createdAt','deadline'])||s.version!==1||!uuid.test(s.id)||!['delivery','craft_delivery'].includes(s.kind)||!name.test(s.item)||!integer(s.count,32)||s.count<1||!keys(s.input,['item','count'])||!name.test(s.input.item)||!integer(s.input.count,32)||s.input.count<1||!integer(s.createdAt,Number.MAX_SAFE_INTEGER)||!integer(s.deadline,Number.MAX_SAFE_INTEGER)||s.deadline<=s.createdAt||s.deadline-s.createdAt>86400000||!Array.isArray(s.stages)||s.stages.length!==2)throw Error('WORK_ORDER_SPEC_INVALID')
  const [a,b]=s.stages
  for(const stage of s.stages)if(!keys(stage,['worker','action','item','count','source','destination'])||!Object.hasOwn(workerSlots,stage.worker)||!chest(stage.source)||!chest(stage.destination)||!name.test(stage.item)||!integer(stage.count,32)||stage.count<1)throw Error('WORK_ORDER_STAGE_INVALID')
  if(a.worker===b.worker||a.action!=='supply'||b.action!==s.kind||a.source.slot!==workerSlots[a.worker]||a.source.role!=='sourceChest'||a.destination.slot!==workerSlots[b.worker]||a.destination.role!=='sourceChest'||workDigest(a.destination)!==workDigest(b.source)||b.destination.slot!==workerSlots[b.worker]||b.destination.role!=='destinationChest'||a.item!==s.input.item||a.count!==s.input.count||b.item!==s.item||b.count!==s.count)throw Error('WORK_ORDER_STAGE_INVALID')
  const recipe=recipes[s.item]
  if(s.kind==='delivery'&&(s.input.item!==s.item||s.input.count!==s.count)||s.kind==='craft_delivery'&&(!recipe||s.count%recipe.output!==0||s.input.item!==recipe.item||s.input.count!==s.count/recipe.output*recipe.input))throw Error('WORK_ORDER_RECIPE_INVALID')
  return s
}

export function makeWorkSpec({id,kind,item,count,worker,regions,now=Date.now()}){
  const other=worker==='claude'?'0g':'claude',recipe=recipes[item]
  const source=regions.find(r=>r.slotName===workerSlots[worker]),target=regions.find(r=>r.slotName===workerSlots[other])
  if(!source||!target)throw Error('WORK_ORDER_OWNED_REGIONS_REQUIRED')
  const input=kind==='craft_delivery'&&recipe?{item:recipe.item,count:count/recipe.output*recipe.input}:{item,count}
  const box=(region,role)=>({slot:region.slotName,role,position:region[role]})
  return validateWorkSpec({version:1,id,kind,item,count,input,stages:[{worker,action:'supply',item:input.item,count:input.count,source:box(source,'sourceChest'),destination:box(target,'sourceChest')},{worker:other,action:kind,item,count,source:box(target,'sourceChest'),destination:box(target,'destinationChest')}],createdAt:now,deadline:now+3600000})
}

export function validateWorkRecord(r,server){
  if(!keys(r,['recordType','server','order','kind','item','status','stage','deadline','data'])||r.recordType!=='work-order'||r.server!==server||!statuses.has(r.status)||!integer(r.stage,2)||!keys(r.data,['version','spec','specDigest','verifications','claim','fixture'])||r.data.version!==1||typeof r.data.fixture!=='boolean')throw Error('WORK_ORDER_RECORD_INVALID')
  const s=validateWorkSpec(r.data.spec)
  if(s.id!==r.order||s.kind!==r.kind||s.item!==r.item||s.deadline!==r.deadline||workDigest(s)!==r.data.specDigest||!Array.isArray(r.data.verifications)||r.data.verifications.length!==r.stage)throw Error('WORK_ORDER_RECORD_INVALID')
  if(r.status==='completed'&&r.stage!==2||r.status==='awaiting_handoff'&&r.stage!==1)throw Error('WORK_ORDER_STATE_INVALID')
  const claim=r.data.claim
  if((r.status==='working')!==(claim!==null)||r.stage===2&&!['completed','cancelled'].includes(r.status))throw Error('WORK_ORDER_STATE_INVALID')
  if(claim!==null&&(!keys(claim,['worker','stage','expiresAt'])||claim.worker!==s.stages[r.stage]?.worker||claim.stage!==r.stage||claim.expiresAt!==r.deadline))throw Error('WORK_ORDER_CLAIM_INVALID')
  for(const [i,p]of r.data.verifications.entries()){
    if(!keys(p,['stage','worker','item','count','job','observedAt','worldUuid','evidenceDigest','receiptDigest','sourceBefore','sourceAfter','destinationBefore','destinationAfter'])||p.stage!==i||p.worker!==s.stages[i].worker||p.item!==s.stages[i].item||p.count!==s.stages[i].count||!uuid.test(p.job)||!uuid.test(p.worldUuid)||!hash.test(p.evidenceDigest)||!hash.test(p.receiptDigest)||!integer(p.observedAt,Number.MAX_SAFE_INTEGER)||!['sourceBefore','sourceAfter','destinationBefore','destinationAfter'].every(k=>integer(p[k]))||p.destinationAfter-p.destinationBefore!==p.count||p.sourceBefore-p.sourceAfter!==s.input.count)throw Error('WORK_ORDER_VERIFICATION_INVALID')
  }
  if(new TextEncoder().encode(JSON.stringify(r)).length>16000)throw Error('WORK_ORDER_RECORD_TOO_LARGE')
  return r
}

export function createWorkOrderReader(progress){
  const {client,server,publisher}=progress
  const decode=row=>{
    if(row.$owner?.toLowerCase()!==publisher.toLowerCase())throw Error('ARKIV_PUBLISHER_MISMATCH')
    const r=validateWorkRecord({recordType:'work-order',server:row.server.value,order:row.orderId.value,kind:row.kind.value,item:row.item.value,status:row.status.value,stage:Number(row.stage.value),deadline:Number(row.deadline.value),data:JSON.parse(hexToString(row.data.value))},server)
    if(!hash.test(row.$key)||row.revision.value<1n||row.revision.value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('WORK_ORDER_ENTITY_INVALID')
    return {...r,entityKey:row.$key,revision:Number(row.revision.value),owner:row.$owner,expiresAtBlock:String(row.$expiresAt)}
  }
  return{
    client,server,publisher,
    async get(key){if(!hash.test(key))throw Error('ARKIV_ENTITY_KEY_REQUIRED');return decode(await client.getEntity(key,WorkOrder))},
    async list({kind,item}={}){
      if(kind!==undefined&&!['delivery','craft_delivery'].includes(kind)||item!==undefined&&!name.test(item))throw Error('WORK_ORDER_QUERY_INVALID')
      const predicates=[eq('server',server)];if(kind)predicates.push(eq('kind',kind));if(item)predicates.push(eq('item',item))
      const latest=new Map();let offset=0,blockNumber,rejected=0
      for(let page=0;page<5;page++){
        const result=await client.select('*').from(WorkOrder).ownedBy(publisher).where(and(...predicates)).orderBy(desc('revision')).limit(100).offset(offset).fetch();blockNumber=String(result.blockNumber)
        for(const row of result.entities){try{const r=decode(row);if(!latest.has(r.order))latest.set(r.order,r)}catch{rejected++}}
        const covered=result.entities.length+result.skipped
        if(covered<100)return{source:'live-arkiv',chainId:7794095,server,publisher,blockNumber,records:[...latest.values()],rejected}
        offset+=covered
      }
      throw Error('WORK_ORDER_QUERY_TOO_LARGE')
    }
  }
}

export function withWorkOrders(progress,validateProgress){
  const orders=createWorkOrderReader(progress)
  return{...progress,orders,
    validate:r=>r?.recordType==='work-order'?validateWorkRecord(r,progress.server):validateProgress(r,progress.server),
    definition(r,revision){return r.recordType==='work-order'?{schema:WorkOrder,values:{server:r.server,orderId:r.order,kind:r.kind,item:r.item,status:r.status,stage:u64(r.stage),deadline:u64(r.deadline),revision:u64(revision),data:bytes(stringToHex(JSON.stringify(r.data)))}}:null},
    recordOf(found){return found.recordType==='work-order'?Object.fromEntries(['recordType','server','order','kind','item','status','stage','deadline','data'].map(k=>[k,found[k]])):Object.fromEntries(['server','task','job','provider','status','facts'].map(k=>[k,found[k]]))},
    async get(key){try{return await progress.get(key)}catch(error){if(error.name!=='SchemaMismatchError')throw error;return orders.get(key)}}
  }
}
