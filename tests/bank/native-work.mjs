import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { keccak256, stringToHex } from '../../backend/node_modules/viem/_esm/index.js'
import { createBankLaptopRuntime } from '../../backend/src/bank/laptop-runtime.mjs'
import { digest } from '../../backend/src/world-assets/canonical.mjs'

const root=resolve(new URL('../..',import.meta.url).pathname),runId=randomUUID(),run=process.argv.includes('--run')
const directory=join(root,'evidence/runs/bank-native-work',runId),stateFile=join(root,'.local/bank/native-work-proof.json')
await mkdir(directory,{recursive:true})
const report={runId,status:'fail',recordedAt:new Date().toISOString(),scope:run?'Actual Unichain Sepolia funded native2x2platform, forged-result refusal and lost-reply recovery using operator-controlled wallets. No human/Privy/0G qualification.':'Unpaid native work preflight only; no blockchain transaction or physical agent action.',checks:[],paidModelCalls:0}
let app,state
async function save(){const temporary=stateFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(temporary,stateFile)}
async function actorSettings(){return JSON.parse(await readFile(join(root,'.local/bank/operator-settings.json'),'utf8'))}
async function taskCheckpoint(){const active=JSON.parse(await readFile(join(root,'.local/playable-world/active.json'),'utf8'));return JSON.parse(await readFile(join(active.runtime,'personal-agent-tasks.json'),'utf8'))}
async function balance(){return(await app.wallets.balances(state.workerId)).tokens.city}

try{
 app=await createBankLaptopRuntime({rootDirectory:root})
 assert(app.nativeWork,'native work runtime exists')
 const settings=await actorSettings(),requester=settings.actors.borrower,worker=settings.actors.worker
 if(!run){
  const sourceWorkId=randomUUID(),workId=keccak256(stringToHex(sourceWorkId)),plan={action:'build_platform',width:2,depth:2,material:'oak_planks'},amount='1'
  const terms={sourceWorkId,requesterId:requester.principalId,workerId:worker.principalId,plan,amount},termsHash='0x'+digest(terms)
  await app.nativeWork.prepare({...terms,workId,termsHash})
  await assert.rejects(app.nativeWork.run({workId,principalId:requester.principalId}),/BANK_NATIVE_FUNDED_TERMS_CHANGED/)
  await assert.rejects(app.nativeWork.authorize({action:'workstart',workId,termsHash,principalId:requester.principalId}),/BANK_NATIVE_FUNDED_TERMS_CHANGED/)
  await assert.rejects(app.nativeWork.prepare({...terms,workId,termsHash,amount:'2'}),/BANK_NATIVE_EXACT_QUOTED_PLAN_REQUIRED/)
  await assert.rejects(app.nativeWork.authorize({action:'workcomplete',workId,termsHash:'0x'+'11'.repeat(32),principalId:requester.principalId,request:{resultHash:'0x'+'22'.repeat(32)}}),/BANK_NATIVE_INSPECTOR_TERMS_REQUIRED/)
  report.checks.push('Unpaid work cannot start or build','Changed quoted amount refused','Forged work terms refused')
  report.publicTransactions=0;report.status='pass'
 }else{
  try{state=JSON.parse(await readFile(stateFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  if(!state){
   const initialWorkerBalance=(await app.wallets.balances(worker.principalId)).tokens.city
   const fund=await app.preview({principalId:requester.principalId,action:'fund_work',workerId:worker.principalId,task:'platform',amount:'1'})
   state={principalId:requester.principalId,workerId:worker.principalId,initialWorkerBalance,workId:fund.exact.terms.workId,
    termsHash:fund.exact.terms.termsHash,fund:{principalId:requester.principalId,operationId:fund.operationId,termsDigest:fund.termsDigest}}
   await save()
  }
  assert.equal(state.principalId,requester.principalId);assert.equal(state.workerId,worker.principalId)
  const funded=await app.confirm(state.fund);assert.equal(funded.status,'complete')
  report.funding=funded.proofs
  if(!state.start){const preview=await app.preview({principalId:state.principalId,action:'run_work',workId:state.workId});state.start={principalId:state.principalId,operationId:preview.operationId,termsDigest:preview.termsDigest};await save()}
  if(!state.injected){
   const original=app.nativeWork.run.bind(app.nativeWork)
   app.nativeWork.run=async request=>{
    const result=await original(request)
    await assert.rejects(app.nativeWork.authorize({action:'workcomplete',workId:state.workId,termsHash:state.termsHash,
     principalId:state.principalId,request:{resultHash:'0x'+'33'.repeat(32)}}),/BANK_NATIVE_FORGED_RESULT_REFUSED/)
    state.injected=true;state.resultHash=result.resultHash;state.taskId=result.taskId;state.firstCheckpoint=await taskCheckpoint();await save()
    throw Error('INJECTED_LOST_NATIVE_REPLY_AFTER_REAL_BUILD')
   }
   await assert.rejects(app.confirm(state.start),/INJECTED_LOST_NATIVE_REPLY_AFTER_REAL_BUILD/)
   assert.equal(await balance(),state.initialWorkerBalance)
   report.checks.push('Four actual placements finish after canonical funding/start','Forged raw completion hash refused','Lost native reply leaves payment unreleased')
  }
  await app.close();app=await createBankLaptopRuntime({rootDirectory:root})
  const resumed=await app.confirm(state.start);assert.equal(resumed.status,'complete')
  const after=await taskCheckpoint(),first=state.firstCheckpoint.tasks.find(value=>value.id===state.taskId)
  const same=after.tasks.find(value=>value.id===first.id)
  assert.deepEqual(same.receipts,first.receipts);assert.deepEqual(same.completed,first.completed)
  report.checks.push('Service recreation and same-operation retry consume no extra materials and place no extra blocks')
  if(!state.accept){const accept=await app.preview({principalId:state.principalId,action:'accept_work',workId:state.workId});state.accept={principalId:state.principalId,operationId:accept.operationId,termsDigest:accept.termsDigest};await save()}
  const accepted=await app.confirm(state.accept);assert.equal(accepted.status,'complete')
  assert.equal(BigInt(await balance())-BigInt(state.initialWorkerBalance),10n**18n)
  await app.confirm(state.accept);assert.equal(BigInt(await balance())-BigInt(state.initialWorkerBalance),10n**18n)
  const result=await app.nativeWork.run({workId:state.workId,principalId:state.principalId});assert.equal(result.status,'accepted');assert.equal(result.resultHash,state.resultHash)
  const active=JSON.parse(await readFile(join(root,'.local/playable-world/active.json'),'utf8')),locks=JSON.parse(await readFile(join(active.runtime,'plugins/AgentCity/task-region-locks.json'),'utf8'))
  assert(!locks[first.slotName])
  report.checks.push('Requester acceptance pays exactly1CITY once','Only canonical settlement releases the native plot lock')
  report.workId=state.workId;report.resultHash=state.resultHash;report.taskId=first.id;report.acceptance=accepted.proofs
  const placementReceipts=Object.entries(first.receipts).filter(([id])=>id.includes(':place:')).map(([operationId,receipt])=>({operationId,...receipt}))
  const materialsConsumed=placementReceipts.reduce((sum,receipt)=>sum+Number(receipt.before.inventory.oak_planks||0)-Number(receipt.after.inventory.oak_planks||0),0)
  assert.equal(placementReceipts.length,4);assert.equal(materialsConsumed,4)
  report.nativeExecution={plan:first.plan,completed:first.completed,receipts:placementReceipts}
  const beforeRejectedPreview=await app.wallets.balances(state.principalId)
  await assert.rejects(app.preview({principalId:state.principalId,action:'fund_work',workerId:state.workerId,task:'platform',amount:'1'}),/BANK_NATIVE_NEW_FOOTPRINT_REQUIRED/)
  assert.deepEqual(await app.wallets.balances(state.principalId),beforeRejectedPreview)
  report.checks.push('A second occupied-footprint work quote fails before any financial signature or balance change')
  report.placements=placementReceipts.length;report.materialsConsumed=materialsConsumed;report.status='pass'
 }
}catch(error){report.error=error.message;process.exitCode=1}
finally{await app?.close();report.sources={};for(const file of ['backend/src/bank/native-work.mjs','tests/bank/native-work.mjs'])report.sources[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
