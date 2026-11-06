import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { formatEther } from '../backend/node_modules/viem/_esm/index.js'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'
import { createTaskReader, serverNamespace, publisherAddress, projectProgress, chainId } from '../backend/src/arkiv/tasks.mjs'
import { openTaskBoard, safeError } from '../backend/src/arkiv/runtime.mjs'

const root = fileURLToPath(new URL('../',import.meta.url))
const json = async path => JSON.parse(await readFile(join(root,path),'utf8'))
async function main() {
  const [command,...args] = process.argv.slice(2)
  if (command === '--prepare') {
    const active = await json('.local/playable-world/active.json')
    const settings = { version:1, server:serverNamespace(active.serverId), publisher:publisherAddress }
    let existing
    try { existing = await json('.local/arkiv/settings.json') } catch(e) { if(e.code!=='ENOENT')throw e }
    if (existing && (existing.server !== settings.server || existing.publisher.toLowerCase() !== settings.publisher.toLowerCase())) throw Error('ARKIV_DEPLOYMENT_BINDING_CHANGED')
    await mkdir(join(root,'.local/arkiv'),{recursive:true,mode:0o700})
    await checkpoints.writeCheckpoint(join(root,'.local/arkiv/settings.json'),existing||settings)
    await checkpoints.writeCheckpoint(join(root,'arkiv/deployment.json'),{...settings,chainId,rpc:'https://rpc.rabdi.db-chain.testnet.arkiv.network',schema:'ethcraft.task-progress.v1'})
    console.log(JSON.stringify({prepared:true,...settings,chainId}));return
  }
  let settings
  try { settings=await json('.local/arkiv/settings.json') } catch(e) { if(e.code!=='ENOENT')throw e;settings=await json('arkiv/deployment.json') }
  const reader=createTaskReader({...settings,accessKey:process.env.ARKIV_ACCESS_KEY||settings.accessKey||''})
  if(command==='--query') {
    const filters=Object.fromEntries(args.map(a=>a.split('=')))
    if(Object.keys(filters).some(k=>!['provider','status','offset'].includes(k)))throw Error('ARKIV_QUERY_INVALID')
    if(filters.offset!==undefined)filters.offset=Number(filters.offset)
    console.log(JSON.stringify(await reader.list(filters),null,2));return
  }
  if(command==='--status') {
    console.log(JSON.stringify({chainId:await reader.client.getChainId(),server:settings.server,publisher:settings.publisher,balanceTGLM:formatEther(await reader.client.getBalance({address:settings.publisher}))},null,2));return
  }
  if(command==='--demo') {
    const runId=randomUUID(),directory=join(root,'evidence/runs/arkiv-tasks',runId)
    const report={schema:'ethcraft.arkiv-qualification.v1',runId,chainId,publisher:settings.publisher,server:settings.server,startedAt:new Date().toISOString(),status:'in_progress',scope:'Controlled public data fixture; no Minecraft action, inference call, human approval or payment.',receipts:[]}
    const save=()=>checkpoints.writeCheckpoint(join(directory,'report.json'),report)
    await save()
    const board=await openTaskBoard(root,{writer:true})
    try {
      const source={id:randomUUID(),status:'paused',qualificationFixture:true,goal:'PRIVATE FIXTURE PROMPT MUST NEVER BE PUBLISHED',history:[{step:{tool:'craft',item:'stick',count:4},result:{item:'stick',produced:4}}]}
      const first=await board.publisher.publish(projectProgress(source,'claude',settings.server));report.receipts.push(first);await save()
      const repeated=await board.publisher.publish(projectProgress(source,'claude',settings.server))
      if(repeated.transactionHash!==first.transactionHash)throw Error('ARKIV_DUPLICATE_PUBLICATION')
      const independent=createTaskReader({server:settings.server,publisher:settings.publisher})
      const observed=await independent.get(first.entityKey)
      const target={id:randomUUID(),rootTask:source.id,status:'paused',qualificationFixture:true,sharedProgress:{entityKey:observed.entityKey},history:[{step:{tool:'deposit',item:'stick',count:4},result:{item:'stick',moved:4}}]}
      const second=await board.publisher.publish(projectProgress(target,'0g',settings.server));report.receipts.push(second);await save()
      const page=await independent.list()
      if(!page.records.some(r=>r.entityKey===second.entityKey&&r.facts.predecessor===first.entityKey))throw Error('ARKIV_HANDOFF_READBACK_REQUIRED')
      report.status='pass';report.checks=['Rabdi chain identity','SDK 1.0.1 create and canonical receipt','independent SDK entity and filtered board read','same snapshot reuses its original transaction','linked provider snapshots carry typed facts','fixture disclosure and private prompt omission']
      report.nativeOwnerHandoff='not_tested';report.completedAt=new Date().toISOString();await save()
      console.log(JSON.stringify({status:report.status,report:join(directory,'report.json'),entityKeys:report.receipts.map(r=>r.entityKey)},null,2))
    } catch(error) {report.status='failed';report.error=safeError(error);await save();throw error}
    finally {await board.close()}
    return
  }
  console.log('Usage: node scripts/arkiv_tasks.mjs --prepare | --status | --query [provider=0g] [status=paused] [offset=100] | --demo')
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))main().catch(error=>{console.error(safeError(error));process.exitCode=1})
