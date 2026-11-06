// Actual owned isolated world only; no player impersonation, item grants or paid calls.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
const root=resolve(new URL('../..',import.meta.url).pathname),json=async p=>JSON.parse(await readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex')
assert.equal(process.argv.length,2)
const meta=await json(join(root,'.local/mumbai-city/isolated-active.json'))
assert.equal(meta.owner,'agentcity-mumbai-city-isolated');assert.match(meta.id,/^[a-f0-9]{32}$/)
assert.equal(meta.runtime,join(root,'.local/mumbai-city/isolated',meta.id));assert.equal(meta.container,'agentcity-mumbai-city-'+meta.id.slice(0,8))
assert.equal(meta.controlPort,25997);assert.equal(meta.gamePort,25996)
const token=(await readFile(join(meta.runtime,'api-token'),'utf8')).trim()
assert.equal(hash(await readFile(join(meta.runtime,'plugins/AgentCity.jar'))),meta.pluginSha256)
const native=async()=>{const r=await fetch('http://127.0.0.1:25997/playable/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json()}
const rconPassword=(await readFile(join(meta.runtime,'server.properties'),'utf8')).split('\n').find(s=>s.startsWith('rcon.password='))?.slice(14);assert(rconPassword)
let rconTail=Promise.resolve()
function fixtureCommands(commands){
  const work=rconTail.then(async()=>{
    const packet=(id,type,text)=>{const body=Buffer.concat([Buffer.alloc(8),Buffer.from(text),Buffer.alloc(2)]);body.writeInt32LE(id,0);body.writeInt32LE(type,4);const size=Buffer.alloc(4);size.writeInt32LE(body.length);return Buffer.concat([size,body]).toString('base64')}
    const encoded=[packet(1,3,rconPassword),...commands.map((command,i)=>packet(i+2,2,command))].join('\n')+'\n'
    return await new Promise((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',meta.container,'bash','-c','exec 3<>/dev/tcp/127.0.0.1/25575; while IFS= read -r encoded; do printf "%s" "$encoded" | base64 -d >&3; sleep 0.3; done; timeout 1 cat <&3'],{timeout:12000,maxBuffer:32768},(error,stdout)=>error&&error.code!==124?reject(Error('ISOLATED_MOB_CONTROL_FAILED')):resolve(stdout))
      child.stdin.end(encoded)
    })
  });rconTail=work.catch(()=>{});return work
}
const runId=randomUUID(),directory=join(root,'evidence/runs/mumbai-mob-free',runId),marker=join(root,'.local/mumbai-city/isolated-verification.json')
await mkdir(directory,{recursive:true});try{await rename(marker,marker+'.previous-'+runId)}catch(e){if(e.code!=='ENOENT')throw e}
const report={schema:'agentcity.mumbai-mob-free-check.v1',status:'fail',isolatedId:meta.id,pluginSha256:meta.pluginSha256,serverId:meta.serverId,worldIds:meta.sourceWorldIds,scope:'Actual owned isolated copy; roaming creatures disabled, service NPCs preserved. No real owner or independent-human qualification.',checks:[],paidModelCalls:0,walletSignatures:0,publicTransactions:0,fixtureConditions:{forcedBankChunks:'1660 2793 1722 2854',scope:'Owned isolated copy only; no player client is used'}}
const check=(name)=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const inspect=async()=>{const s=await native(),worlds=s.mumbai.mobControl;report.lastObserved=worlds;assert(worlds&&Object.keys(worlds).length>=7);assert(Object.values(worlds).every(w=>!w.naturalSpawning&&w.roamingMobs===0));assert.equal(worlds.agentcity_mumbai.serviceNpcs,5);assert.equal(s.mumbai.survival,true);return worlds}
try{
  // No human client loads the bank in this isolated check. Keep its existing NPC chunks loaded.
  await fixtureCommands(['execute in minecraft:agentcity_mumbai run forceload add 1660 2793 1722 2854'])
  await delay(1600);report.initial=await inspect();check('All loaded worlds have no roaming creatures or natural spawning; five actual Mumbai service NPCs remain in Survival')
  const responses=await fixtureCommands(['cow','creeper'].map((type,i)=>'execute in minecraft:agentcity_mumbai run summon minecraft:'+type+' '+(1700+i)+' 69 2810 {Tags:["AgentCityMobFreeFixture"]}'))
  assert((responses.match(/Summoned new/g)||[]).length>=2,'The controlled passive/hostile spawn probes must actually succeed before removal')
  await delay(1600);await inspect();check('Both actually summoned passive and hostile creatures are removed without inventory grants')
  await promisify(execFile)('docker',['restart','--time','60',meta.container],{timeout:90000})
  let ready=false;for(let i=0;i<180;i++){try{await inspect();ready=true;break}catch{}await delay(500)}assert(ready,'Mob-free mode and service NPCs must survive restart')
  const code='import json,sys;from pathlib import Path;sys.path.insert(0,"scripts");import mumbai_host;print(json.dumps(mumbai_host.world_ids(Path(sys.argv[1]))))'
  const {stdout}=await promisify(execFile)('python3',['-c',code,meta.runtime],{cwd:root});assert.deepEqual(JSON.parse(stdout),meta.sourceWorldIds)
  check('Restart retains mob-free rules, five service NPCs and all seven world identities')
  report.status='pass'
}catch(e){report.error=e.message}
report.finishedAt=new Date().toISOString();const path=join(directory,'report.json');await writeFile(path,JSON.stringify(report,null,2)+'\n')
if(report.status==='pass')await writeFile(marker,JSON.stringify({owner:'agentcity-mumbai-city-isolated-proof',status:'pass',isolatedId:meta.id,pluginSha256:meta.pluginSha256,serverId:meta.serverId,worldIds:meta.sourceWorldIds,worldUuid:meta.worldUuid,sourceActiveSha256:meta.sourceActiveSha256,sourceMumbaiConfigSha256:meta.sourceMumbaiConfigSha256,sourceWorldIds:meta.sourceWorldIds,report:relative(root,path),reportSha256:hash(await readFile(path))},null,2)+'\n',{mode:0o600})
console.log(JSON.stringify({status:report.status,error:report.error,evidence:path}));if(report.status!=='pass')process.exitCode=1
