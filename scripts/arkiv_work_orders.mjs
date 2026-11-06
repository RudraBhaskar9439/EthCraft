// Publish the already verified isolated native test as clearly labelled testnet fixtures.
import {readFile} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {openTaskBoard} from '../backend/src/arkiv/runtime.mjs'
import {createTaskReader,validateProgress} from '../backend/src/arkiv/tasks.mjs'
import {withWorkOrders} from '../backend/src/arkiv/work-order-schema.mjs'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'
const root=fileURLToPath(new URL('../',import.meta.url)),json=async file=>JSON.parse(await readFile(file,'utf8'))
async function main(){
 if(process.argv.length!==3||process.argv[2]!=='--native-demo')throw Error('USE_NATIVE_DEMO_ONLY')
 const meta=await json(join(root,'.local/mumbai-city/isolated-active.json')),proof=await json(join(root,'.local/mumbai-city/isolated-verification.json'))
 const path=resolve(root,proof.report)
 if(!path.startsWith(join(root,'evidence/runs/arkiv-work-orders-native/'))||meta.id!==proof.isolatedId||proof.status!=='pass')throw Error('ACTUAL_NATIVE_WORK_ORDER_PROOF_REQUIRED')
 const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==proof.reportSha256)throw Error('NATIVE_PROOF_DIGEST_CHANGED')
 const native=JSON.parse(bytes)
 if(native.status!=='pass'||native.isolatedId!==meta.id||native.pluginSha256!==meta.pluginSha256||native.publicTransactions!==0)throw Error('NATIVE_PROOF_BINDING_REQUIRED')
 const state=await json(join(meta.runtime,'work-order-fixture/.local/arkiv/work-orders.json')),order=state.orders[0]
 if(!order?.fixture||order.status!=='completed'||order.verifications.length!==2)throw Error('COMPLETED_NATIVE_FIXTURE_REQUIRED')
 const id=randomUUID(),directory=join(root,'evidence/runs/arkiv-work-orders',id),report={schema:'ethcraft.arkiv-work-orders-public-check.v1',runId:id,status:'in_progress',scope:'Real Rabdi publications of an actual isolated native test. Controlled owner and scripted planner; no live-player or independent-human qualification.',nativeProof:relative(root,path),nativeProofSha256:proof.reportSha256,receipts:[]}
 const save=()=>checkpoints.writeCheckpoint(join(directory,'report.json'),report)
 await save();const board=await openTaskBoard(root,{writer:true})
 try{
  for(const [stage,status]of [[0,'open'],[1,'awaiting_handoff'],[2,'completed']]){
   const record={recordType:'work-order',server:board.server,order:order.id,kind:order.spec.kind,item:order.spec.item,status,stage,deadline:order.spec.deadline,data:{version:1,spec:order.spec,specDigest:order.specDigest,verifications:order.verifications.slice(0,stage),claim:null,fixture:true}}
   const published=await board.publisher.publish(record),repeat=await board.publisher.publish(record)
   if(published.transactionHash!==repeat.transactionHash)throw Error('DUPLICATE_PUBLICATION_RETRY')
   report.receipts.push(published);await save()
  }
  const independent=withWorkOrders(createTaskReader({server:board.server,publisher:board.publisher.state.publisher}),validateProgress)
  const latest=report.receipts.at(-1),read=await independent.orders.get(latest.entityKey),page=await independent.orders.list({kind:'craft_delivery',item:'stick'})
  if(read.status!=='completed'||read.stage!==2||!page.records.some(r=>r.entityKey===latest.entityKey))throw Error('INDEPENDENT_WORK_ORDER_READ_REQUIRED')
  report.status='pass';report.checks=['Actual SDK WorkOrder create and canonical receipt','Three immutable stage snapshots','Repeated publication reuses identical transaction','Second client reads complete specification and two server attestations','Indexed kind/item query returns latest revision'];report.completedAt=new Date().toISOString();await save()
  console.log(JSON.stringify({status:report.status,evidence:relative(root,join(directory,'report.json')),entityKey:latest.entityKey}))
 }catch(error){report.status='fail';report.error=/^[A-Z0-9_]+$/.test(error.message)?error.message:'ARKIV_TEST_UNAVAILABLE';await save();throw error}
 finally{await board.close()}
}
main().catch(error=>{console.error(/^[A-Z0-9_]+$/.test(error.message)?error.message:'ARKIV_TEST_UNAVAILABLE');process.exitCode=1})
