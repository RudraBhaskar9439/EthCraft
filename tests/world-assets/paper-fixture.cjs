'use strict'
// Windows Docker preparation only. Never joins a player or configures a chain.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const {randomUUID,randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'../..'),owner='world-assets-seam-fixture',expectedJar='c9a108690fad15f8d15702b6d6c67468dab438c6ba5d6837fbf0938b28c02a69'
const sha=value=>createHash('sha256').update(value).digest('hex'),linux=file=>'/mnt/'+file[0].toLowerCase()+file.slice(2).replaceAll('\\','/')
function docker(args,options={}){return execFileSync('docker',args,{encoding:'utf8',timeout:120000,...options}).trim()}
async function jars(base,dir){const output=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())output.push(...await jars(base,file));else if(entry.name.endsWith('.jar'))output.push('/compat/'+path.relative(base,file).replaceAll('\\','/'))}return output}
async function preparePaperFixture({artifact=path.join(root,'.local/world-assets-build/bd0919a8-fe9c-4836-b354-cd82979517a8/AgentCity.jar'),expectedArtifactSha256=expectedJar,stock='sword',legacyCompatibility=false,minecraftPort=25606,apiPort=25607}={}){
 assert.equal(process.platform,'win32','Use the healthy Windows Docker CLI; do not restart Docker or WSL')
 assert.match(expectedArtifactSha256,/^[a-f0-9]{64}$/);assert.equal(sha(await fs.readFile(artifact)),expectedArtifactSha256);assert(['sword','resource','both'].includes(stock))
 assert([[25606,25607],[25616,25617]].some(([game,api])=>game===minecraftPort&&api===apiPort),'Only dedicated loopback fixture port pairs are allowed')
 const runId=randomUUID(),runtime=path.join(root,'.local/world-assets-seam',runId),container='agentcity-world-assets-seam-'+runId.slice(0,8),token=randomBytes(32).toString('hex')
 const active=JSON.parse(await fs.readFile(path.join(root,'.local/playable-world/active.json'),'utf8'));assert.equal(active.owner,'agentcity-playable-pilot')
 const source=path.join(root,'.local/playable-world',active.container),compat=path.join(root,'.local/compatibility/server'),directory=path.join(runtime,'plugins/AgentCity')
 await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(runtime,'fixture-classes'),{recursive:true})
 // Immutable calculator manifests/history are needed by the existing plugin.
 // No world chunks, player data, stock inventories, wallet keys or sale journals
 // are copied. Every physical world below is newly generated and fixture-only.
 for(const name of ['deployment.json','initialized-job','operations.journal','blueprint.json','tests.json','construction-access.json'])await fs.copyFile(path.join(source,'plugins/AgentCity',name),path.join(directory,name))
 await fs.copyFile(artifact,path.join(runtime,'plugins/AgentCity.jar'));await fs.copyFile(path.join(source,'paper.jar'),path.join(runtime,'paper.jar'))
 for(const name of ['ViaVersion.jar','ViaBackwards.jar'])await fs.copyFile(path.join(source,'plugins',name),path.join(runtime,'plugins',name))
 const pins=JSON.parse(await fs.readFile(path.join(root,'config/property-dependencies.json'),'utf8'))
 for(const dependency of pins.artifacts){const file=path.join(root,'.local/property-deps',dependency.file);assert.equal(sha(await fs.readFile(file)),dependency.sha256);await fs.copyFile(file,path.join(runtime,'plugins',dependency.file))}
 await fs.writeFile(path.join(directory,'world-assets-enabled'),'New isolated equipment/chain seam fixture only.\n');await fs.writeFile(path.join(runtime,'world-assets-seam-fixture'),runId+'\n')
 await fs.writeFile(path.join(runtime,'fixture-stock-mode'),stock+'\n')
 await fs.writeFile(path.join(runtime,'api-token'),token+'\n',{mode:0o600});await fs.writeFile(path.join(runtime,'eula.txt'),'eula=true\n');await fs.writeFile(path.join(runtime,'whitelist.json'),'[]\n');await fs.writeFile(path.join(runtime,'ops.json'),'[]\n')
 const deployment=JSON.parse(await fs.readFile(path.join(directory,'deployment.json'),'utf8'))
 await fs.writeFile(path.join(runtime,'server.properties'),['online-mode=false','white-list=true','enforce-whitelist=true','server-port=25565','enable-rcon=false','spawn-protection=0','view-distance=2','simulation-distance=2','max-players=4','difficulty=peaceful','level-name='+deployment.world,'level-type=minecraft:flat','generate-structures=false','generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}'].join('\n')+'\n')
 const cp=[...await jars(compat,path.join(compat,'libraries')),...await jars(compat,path.join(compat,'versions'))].join(':')
 const build=['run','--rm','--network','none','--mount',`type=bind,src=${root},dst=/repo,readonly`,'--mount',`type=bind,src=${compat},dst=/compat,readonly`,'--mount',`type=bind,src=${runtime},dst=/out`,active.javaImage]
 docker([...build,'javac','--release','21','-proc:none','-cp',cp,'-d','/out/fixture-classes','/repo/tests/world-assets/SeamEquipmentStock.java'])
 await fs.writeFile(path.join(runtime,'fixture-classes/plugin.yml'),'name: AgentCityWorldFixture\nversion: 1.0\nmain: org.agentcity.fixture.SeamEquipmentStock\napi-version: \'1.21.11\'\n')
 docker([...build,'jar','--create','--file','/out/plugins/AgentCityWorldFixture.jar','-C','/out/fixture-classes','.'])
 const gear={actor:'EscSeller',count:1,item:'minecraft:diamond_sword',slot:8,damage:7,sharpness:2,name:'Seam fixture blade',lore:true,persistentData:true},resource={actor:'EscSeller',count:3,item:'minecraft:stick',slot:7}
 const config={owner,runId,container,runtime:linux(runtime),runtimeWindows:runtime,apiTokenFile:linux(path.join(runtime,'api-token')),apiTokenFileWindows:path.join(runtime,'api-token'),apiOrigin:'http://127.0.0.1:'+apiPort,minecraft:{host:'127.0.0.1',port:minecraftPort,version:'1.21.11',seller:'EscSeller',buyer:'EscBuyer'},pluginSha256:expectedArtifactSha256,paperSha256:sha(await fs.readFile(path.join(runtime,'paper.jar'))),javaImage:active.javaImage,dependencies:pins.artifacts,fixtureGrant:stock==='resource'?resource:gear,fixtureGrants:stock==='both'?[resource,gear]:[stock==='resource'?resource:gear],legacyCompatibility,infrastructure:'New PlayableExperience initializes its disclosed demonstration task-pad chests; seam test must not withdraw them. No original world or inventory was copied.',chainConfigured:false,playersJoined:false}
 const configPath=path.join(runtime,'fixture.json');await fs.writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600})
 const args=['run','--detach','--pull','never','--name',container,'--label','agentcity.owner='+owner,'--publish',`127.0.0.1:${minecraftPort}:25565`,'--publish',`127.0.0.1:${apiPort}:25578`,'--env','AGENTCITY_API_TOKEN','--mount',`type=bind,src=${runtime},dst=/server`]
 for(const name of ['libraries','versions','cache'])args.push('--mount',`type=bind,src=${path.join(source,name)},dst=/server/${name},readonly`)
 args.push('--workdir','/server','--memory','1536m','--cpus','2',active.javaImage,'java','-Xms256M','-Xmx1100M','-Dagentcity.localFixture=true','-Dagentcity.localConstructionResume=true','-Dagentcity.playable=true');if(legacyCompatibility)args.push('-Dagentcity.legacyGameCoinsFixture=true');args.push('-jar','paper.jar','--nogui')
 docker(args,{env:{...process.env,AGENTCITY_API_TOKEN:token}})
 const deadline=Date.now()+180000;let ready=false
 while(Date.now()<deadline){try{const response=await fetch(config.apiOrigin+'/playable/property/status',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});if(response.ok&&(await response.json()).enabled){ready=true;break}}catch{};await new Promise(resolve=>setTimeout(resolve,500))}
 if(!ready)throw Object.assign(Error('SEAM_PAPER_STARTUP_FAILED'),{configPath,container})
 return{configPath,configPathWsl:linux(configPath),configRelative:path.relative(root,configPath).replaceAll('\\','/'),container,owner,runtimeWindows:runtime,pluginSha256:expectedArtifactSha256,ready:true}
}
async function stopPaperFixture(configPath){const config=JSON.parse(await fs.readFile(configPath,'utf8'));assert.equal(config.owner,owner);assert(/^agentcity-world-assets-seam-[a-f0-9]{8}$/.test(config.container));const metadata=JSON.parse(docker(['inspect',config.container]))[0];assert.equal(metadata.Config.Labels['agentcity.owner'],owner);docker(['stop','--time','45',config.container]);return{stopped:true,container:config.container}}
module.exports={preparePaperFixture,stopPaperFixture}
if(require.main===module)preparePaperFixture().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({status:'fail',message:error.message,configPath:error.configPath,container:error.container}));process.exitCode=1})
