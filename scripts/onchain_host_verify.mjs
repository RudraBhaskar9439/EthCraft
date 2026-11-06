// Actual installed on-chain-only readback. No spending, item movement or signing.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import pg from '../backend/node_modules/pg/lib/index.js'
import {coinTableSnapshots} from './onchain_cutover_check.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),json=async path=>JSON.parse(await readFile(join(root,path),'utf8')),hash=b=>createHash('sha256').update(b).digest('hex'),platformPath=p=>process.platform==='win32'&&p.startsWith('/home/')?'\\\\wsl.localhost\\Ubuntu'+p.replaceAll('/','\\'):p
const report={status:'fail',scope:'Actual on-chain-only plugin/Discord/ledger/custody readback; negative retired-action requests have no effects. No player mint, purchase, withdrawal or wallet signature.',observedAt:new Date().toISOString(),checks:[]}
let pool
try{
 const active=await json('.local/playable-world/active.json');assert.equal(active.owner,'agentcity-playable-pilot')
 const runtime=join(root,'.local/playable-world',active.container),token=(await readFile(join(runtime,'api-token'),'utf8')).trim(),release=await json('config/playable-release.json'),baseline=await json('.local/onchain-cutover-snapshot.json')
 const native=async(path,body)=>{const response=await fetch('http://127.0.0.1:25597/playable/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...body!==undefined?{'Content-Type':'application/json'}:{}},...body!==undefined?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(15000)});return{ok:response.ok,status:response.status,value:await response.json()}}
 const status=await native('status');assert(status.ok);assert.equal(status.value.economyMode,'ONCHAIN_ONLY');assert.equal(status.value.currency,'CITY');assert.equal(status.value.blockchainLinked,true)
 assert.equal(hash(await readFile(join(runtime,'plugins/AgentCity.jar'))),release.pluginSha256);assert.equal((await readFile(join(runtime,'plugins/AgentCity/onchain-only'),'utf8')).trim(),'ONCHAIN_ONLY')
 report.pluginSha256=release.pluginSha256;report.checks.push('installed verified plugin and permanent native mode expose CITY and on-chain-only economy')
 for(const dep of(await json('config/property-dependencies.json')).artifacts)assert.equal(hash(await readFile(join(runtime,'plugins',dep.file))),dep.sha256)
 const manifest=await json('.local/world-assets/asset-market.json'),property=await native('property/status',{});assert(property.ok);assert.equal(property.value.active,true);assert.equal(property.value.worldUUID,'6ff9a1da-a800-4c5e-bf69-de747b3a870e');assert.equal(property.value.source.registry.toLowerCase(),manifest.registry.toLowerCase());assert.equal(property.value.projection.confirmed,true);assert(property.value.projection.confirmations>=2);assert.equal(property.value.projection.parcels.length,4)
 report.checks.push('WorldGuard/WorldEdit release hashes, original estate world identity and fresh confirmed ownership projection retained')
 const database=await json('.local/backend/environment.json');pool=new pg.Pool({connectionString:database.databaseUrl,max:1});assert.deepEqual(await coinTableSnapshots(pool),baseline.tableSnapshots)
 report.checks.push('every archived coin table retains its exact pre-cutover row count and hash; no accounts, grants, payments or legacy trades created')
 for(const entry of baseline.backed){const result=await native('escrow/status',{listingId:entry.listingId});assert(result.ok);assert.equal(result.value.custody.item,entry.item);assert.equal(result.value.custody.count,entry.count);assert.equal(result.value.custody.fingerprint,entry.fingerprint);assert.equal(result.value.custody.state,entry.state)}
 const escrow=await native('escrow/status',{});assert.equal(escrow.value.pendingCount,0);assert.equal(hash(await readFile(join(runtime,'plugins/AgentCity/inventory-escrow.jsonl'))),baseline.journals['inventory-escrow.jsonl'])
 report.backedLegacyLotsRetained=baseline.backed.length;report.checks.push('both original backed stick lots and the complete native inventory journal survive unchanged, with zero unresolved effects')
 const refused=await native('sell',{operationId:randomUUID(),playerId:'135e963d-2027-3e0e-b15c-455d207ac37e',item:'minecraft:oak_planks',count:1});assert(!refused.ok);assert(JSON.stringify(refused.value).includes('onchain_only_legacy_financial_action_disabled'));assert.equal(hash(await readFile(join(runtime,'plugins/AgentCity/inventory-escrow.jsonl'))),baseline.journals['inventory-escrow.jsonl'])
 report.checks.push('direct legacy native shop payout route refuses before effects')
 const settings=await json('.local/discord/settings.json'),credentials=JSON.parse(await readFile(platformPath(settings.credentialsFile),'utf8')),get=async path=>{const response=await fetch('https://discord.com/api/v10/'+path,{headers:{Authorization:'Bot '+credentials.botToken,'User-Agent':'AgentCityHost/1.0'},signal:AbortSignal.timeout(15000)});assert(response.ok);return response.json()}
 const commands=await get('applications/'+settings.applicationId+'/guilds/'+settings.guildId+'/commands');assert(!JSON.stringify(commands).includes('Game Coins'));const assets=commands.find(c=>c.name==='assets');assert(assets.options.some(o=>o.name==='count'));assert(assets.options[0].choices.some(c=>c.value==='wallet'));const bazaar=commands.find(c=>c.name==='bazaar');assert(!bazaar.options[0].choices.some(c=>c.value==='list'||c.value==='buy'))
 const channels=await get('guilds/'+settings.guildId+'/channels'),market=channels.find(c=>c.name==='marketplace'),messages=await get('channels/'+market.id+'/messages?limit=100'),own=messages.filter(m=>m.author.id===settings.applicationId),guide=own.find(m=>m.embeds.some(e=>e.footer?.text==='AgentCity · marketplace-guide'));assert(guide);assert(!JSON.stringify(guide).includes('Game Coin'));assert(!guide.components.some(row=>row.components.some(c=>c.custom_id==='ac:market-browse:self')))
 for(const entry of baseline.backed){const card=own.find(m=>m.components.some(row=>row.components.some(c=>c.custom_id==='ac:market-cancel:'+entry.listingId)));assert(card,'original listing lacks owner withdrawal card');assert(!card.components.some(row=>row.components.some(c=>c.custom_id==='ac:market-preview:'+entry.listingId)))}
 report.checks.push('actual Discord command schema and market guide use CITY; earlier listings offer withdrawal only and no purchase button')
 report.economyMode=status.value.economyMode;report.retiredPendingRequests=status.value.retiredPendingRequests;report.publicTransactions=0;report.playerInventoryChanges=0;report.status='pass'
}catch(error){report.error=error.code||error.message;process.exitCode=1}finally{await pool?.end()}
const dir=join(root,'evidence/runs/onchain-host',randomUUID());await mkdir(dir,{recursive:true});await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,evidence:join(dir,'report.json')}))
