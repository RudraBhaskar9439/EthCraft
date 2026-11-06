// Read-only financial/native preflight. --snapshot writes an ignored baseline,
// never changes account, listing, custody, wallet or chain state.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import pg from '../backend/node_modules/pg/lib/index.js'
import {createCoinRetirement} from '../backend/src/playable/coin-retirement.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),json=async path=>JSON.parse(await readFile(join(root,path),'utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export async function coinTableSnapshots(pool) {
 const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ac_game_%' ORDER BY tablename")).rows.map(row=>row.tablename),snapshots={}
 for(const table of names){assert(/^ac_game_[a-z_]+$/.test(table));const rows=(await pool.query(`SELECT to_jsonb(t)::text snapshot FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;snapshots[table]={rows:rows.length,sha256:hash(Buffer.from(rows.map(row=>row.snapshot).join('\n')))}}
 return snapshots
}
export async function readCutover() {
 const active=await json('.local/playable-world/active.json');assert.equal(active.owner,'agentcity-playable-pilot')
 const runtime=join(root,'.local/playable-world',active.container),token=(await readFile(join(runtime,'api-token'),'utf8')).trim(),settings=await json('.local/backend/environment.json'),pool=new pg.Pool({connectionString:settings.databaseUrl,max:2})
 const native=async(path,body={})=>{const response=await fetch('http://127.0.0.1:25597/playable/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});assert(response.ok,'native '+path);return response.json()}
 try {
  const escrow=await native('escrow/status'),retirement=createCoinRetirement({pool}),state=await retirement.assertCutoverReady({nativeSnapshot:{verified:true,unresolvedIntents:escrow.pendingCount}}),drafts=[],backed=[]
  const listings=(await pool.query("SELECT listing_id,stock_operation_id,item,count,state,terms_digest,stock_receipt FROM ac_game_market_listings WHERE state IN ('stock_pending','open','return_pending') ORDER BY listing_id")).rows
  for(const row of listings){
   if(row.state==='stock_pending'){
    const status=await native('escrow/status',{operationId:row.stock_operation_id})
    assert.equal(status.known,false,'unreconciled stock draft requires original native receipt review');assert.notEqual(status.pending,true)
    drafts.push({listingId:row.listing_id,stockOperationId:row.stock_operation_id,nativeKnown:false,noNativeIntent:true})
   }else{
    const result=await native('escrow/status',{listingId:row.listing_id}),v=result.custody;assert(result.known);assert.equal(v.item,row.item);assert.equal(v.count,row.count);assert.equal(v.termsDigest,row.terms_digest);assert(['held','assigned'].includes(v.state))
    backed.push({listingId:row.listing_id,item:v.item,count:v.count,state:v.state,fingerprint:v.fingerprint})
   }
  }
  const tableSnapshots=await coinTableSnapshots(pool),journals={}
  for(const file of ['inventory-escrow.jsonl','task-region-locks.json'])journals[file]=hash(await readFile(join(runtime,'plugins/AgentCity',file)))
  return{schema:'agentcity.onchain-cutover-baseline.v1',observedAt:new Date().toISOString(),state,tableSnapshots,backed,drafts,journals,pluginSha256:hash(await readFile(join(runtime,'plugins/AgentCity.jar'))),retirementCreatesNoCurrency:true}
 }finally{await pool.end()}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 let report
 try{report={status:'pass',scope:'Actual read-only PostgreSQL/native cutover readiness; zero funds, stock or blockchain changes',...await readCutover()};if(process.argv.includes('--snapshot'))await writeFile(join(root,'.local/onchain-cutover-snapshot.json'),JSON.stringify(report,null,2)+'\n')}
 catch(error){report={status:'fail',error:error.code||error.message};process.exitCode=1}
 const dir=join(root,'evidence/runs/onchain-cutover-preflight',randomUUID());await mkdir(dir,{recursive:true});await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,cutoverReady:report.state?.cutoverReady,backedListings:report.backed?.length,unbackedDrafts:report.drafts?.length,evidence:join(dir,'report.json'),error:report.error}))
}
