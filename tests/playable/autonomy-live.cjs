'use strict'
// Disclosed TaskTester fixture. Default is local journal preflight; --run is an
// explicitly coordinated native-world mutation using existing stock only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {once}=require('node:events'),{randomUUID}=require('node:crypto')
const root=path.resolve(__dirname,'../..'),args=process.argv.slice(2)
const resumeArgument=args[0]==='--resume-report'?args[1]:null
assert.ok(args.length===0||args.length===1&&args[0]==='--run'||args.length===2&&resumeArgument,'Use --run or --resume-report <preparation-failure-report>')
const execute=args.includes('--run')||Boolean(resumeArgument)
require(path.join(root,'tests/compatibility/maintained-candidate/client-profile.cjs'))
const mineflayer=require(path.join(root,'tests/compatibility/node_modules/mineflayer'))
const {pathfinder,Movements,goals}=require(path.join(root,'tests/compatibility/node_modules/mineflayer-pathfinder'))
const {Vec3}=require(path.join(root,'tests/compatibility/node_modules/vec3'))
const report={status:'fail',runId:randomUUID(),scope:'Disclosed TaskTester fixture: direct inspection and explicit-dimension natural-language arch, native gathering, 2-plank/4-stick crafting and carried-item delivery; no grants/resets/wallet actions',checks:[],independentHumansVerified:0,publicTransactions:0}
let bot,runtime,disconnected=false,fixtureRegion,fixtureSpawn
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),messages=[]
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'))
const check=(name,details={})=>{report.checks.push({name,status:'pass',...details});console.log(JSON.stringify({check:name,...details}))}
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{bot?.pathfinder?.setGoal(null);reject(Error(label+' timed out'))},ms)})])}finally{clearTimeout(timer)}}
async function poll(readValue,accept,label,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){if(disconnected)throw Error('Fixture disconnected: '+label);const value=await readValue();if(accept(value))return value;await delay(200)}throw Error('Timed out: '+label)}
async function command(value,accept,timeout=90000){await delay(700);const start=messages.length;bot.chat(value);return poll(()=>messages.slice(start),lines=>lines.some(line=>accept.test(line)),value,timeout)}
async function walk(position,label,range=0){report.lastNavigation={label,target:position,range,from:bot.entity.position.toArray(),startedAt:new Date().toISOString()};try{await bounded(bot.pathfinder.goto(new goals.GoalNear(...position,range)),20000,label);report.lastNavigation.arrived=bot.entity.position.toArray()}catch(error){Object.assign(report.lastNavigation,{error:error.message,position:bot.entity.position.toArray(),onGround:bot.entity.onGround,nearbyPlayers:Object.values(bot.entities).filter(entity=>entity.username&&entity.position.distanceTo(bot.entity.position)<4).map(entity=>({name:entity.username,position:entity.position.toArray()}))});throw error}finally{bot.pathfinder.setGoal(null)}}
async function enterPlot(){
 const region=fixtureRegion,spawn=fixtureSpawn,sx=Math.floor(spawn.x),sz=Math.floor(spawn.z),p=bot.entity.position
 const inside=p.x>=region.min.x&&p.x<region.max.x+1&&p.z>=region.min.z&&p.z<region.max.z+1
 if(!inside){const edge=sx<region.min.x?region.min.x:region.max.x;await walk([sx,region.min.y,sz],'Prepared spawn approach');await walk([edge,region.min.y,sz],'Prepared connector approach')}
}
async function northChestApproach(){
 await enterPlot();const r=fixtureRegion,p=bot.entity.position
 if(p.z<=r.min.z+1)await walk([r.max.x,r.min.y,r.min.z],'Prepared north-east alignment')
 else if(p.x<=r.min.x+2){await walk([r.min.x+1,r.min.y,r.max.z-1],'Prepared west-to-south alignment');await walk([r.max.x,r.min.y,r.max.z-1],'Prepared south-east alignment')}
 else await walk([r.max.x,r.min.y,Math.min(r.max.z-1,Math.max(r.min.z,Math.floor(p.z)))],'Prepared east alignment')
 await walk([r.max.x,r.min.y,r.min.z],'Prepared east-to-north alignment')
 // CityAgent2 waits at minX+1,minZ+1. Stand on the clear northmost row,
 // within native reach of both chests, without asking a path through it.
 await walk([r.min.x+2,r.min.y,r.min.z],'Prepared north-row chest reach')
}
async function chest(position,withdraw=0){await northChestApproach();const target=new Vec3(...position);assert.ok(bot.entity.position.distanceTo(target.offset(0.5,0.5,0.5))<4.5,'Native chest reach from clear north row');const window=await bounded(bot.openChest(bot.blockAt(target)),5000,'Registered chest open');try{if(withdraw)await bounded(window.withdraw(bot.registry.itemsByName.oak_planks.id,null,withdraw),10000,'Exact existing plank withdrawal');const result={};for(const item of window.containerItems())result[item.name]=(result[item.name]||0)+item.count;return result}finally{await bounded(window.close(),5000,'Registered chest close')}}
const inventory=()=>{const value={};for(const item of bot.inventory.items())value[item.name]=(value[item.name]||0)+item.count;return value}
const taskState=()=>read(path.join(runtime,'personal-agent-tasks.json'))
async function waitTasks(previous,actions,label,timeout=240000){return poll(async()=>{const state=await taskState();const tasks=state.tasks.filter(task=>!previous.has(task.id)&&task.ownerId===bot.player.uuid);const failed=tasks.find(task=>['blocked','reconciliation_required'].includes(task.status));if(failed)throw Error(label+': '+failed.message);return tasks},tasks=>actions.every(action=>tasks.some(task=>task.plan.action===action&&task.status==='complete'))&&!tasks.some(task=>task.pending),label,timeout)}
async function run(){
 let parent=null
 if(resumeArgument){
  const file=await fs.realpath(path.resolve(root,resumeArgument)),evidenceRoot=await fs.realpath(path.join(root,'evidence/runs/playable-autonomy'))
  assert.ok(file.startsWith(evidenceRoot+path.sep)&&path.basename(file)==='report.json','Resume only a real report inside repository autonomy evidence')
  parent=await read(file)
  assert.equal(parent.status,'fail');assert.match(parent.error||'',/^Exactly two withdrawn planks placed physically/)
  assert.equal(parent.preflight?.retainedTasks,6);assert.equal(parent.checks?.length,2);assert.equal(parent.requests,undefined,'No prior model or physical task may have started')
  assert.equal(parent.resources?.length,2);assert.equal(parent.expectedArch?.length,7);assert.ok(parent.retainedBlocks?.length)
  report.parentReport=path.relative(root,file);report.resumeMode='Prepared two physical resource blocks; no withdrawal or placement replay'
 }
 const active=await read(path.join(root,'.local/playable-world/active.json'));assert.equal(active.owner,'agentcity-playable-pilot');assert.match(active.container,/^agentcity-playable-[a-f0-9]{8}$/)
 runtime=path.join(root,'.local/playable-world',active.container)
 const saved=await read(path.join(runtime,'personal-agents.json')),priorTasks=await taskState()
 const ruddy=saved.agents.find(agent=>agent.ownerName==='Ruddy');assert.equal(ruddy?.name,'CityAgent1','Retain Ruddy binding')
 const second=saved.agents.find(agent=>agent.name==='CityAgent2');assert.ok(!second||second.ownerName==='TaskTester','Never take another owner slot')
 if(parent){assert.equal(second?.ownerName,'TaskTester');assert.equal(priorTasks.tasks.length,6,'No task identity may have been added since preparation failure');assert.ok(priorTasks.tasks.every(task=>task.status==='complete'))}
 assert.ok(priorTasks.tasks.every(task=>!task.pending&&!['running','finishing','paused','blocked','reconciliation_required'].includes(task.status)),'Do not replace pending tasks')
 report.preflight={ruddyAgent:ruddy.name,fixtureSlot:second?.name||'free CityAgent2',retainedTasks:priorTasks.tasks.length,execute}
 check('existing-owner-and-task-history-preflight',report.preflight)
 if(!execute){report.status='pass';report.scope+='; read-only journal preflight only, no client connected';return}
 const token=(await fs.readFile(path.join(runtime,'api-token'),'utf8')).trim()
 const response=await fetch('http://127.0.0.1:25597/playable/status',{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200)
 const status=await response.json(),region=status.taskRegions.find(value=>value.slotName==='CityAgent2');assert.ok(region)
 assert.equal(status.playWorld,'agentcity_play');report.world=status.playWorld;report.runtimeContainer=active.container
 fixtureRegion=region;fixtureSpawn=status.playSpawn
 if(parent)assert.deepEqual(region,parent.region,'Resume requires the same world task region')
 report.region=region
 bot=mineflayer.createBot({host:'127.0.0.1',port:25596,version:'1.21.11',auth:'offline',username:'TaskTester',hideErrors:true,checkTimeoutInterval:30000})
 bot.on('messagestr',line=>{if(!/AC_SESSION/.test(line))messages.push(line)});bot.on('end',()=>{disconnected=true});bot.on('error',error=>{report.connectionError=error.message})
 await bounded(once(bot,'spawn'),45000,'Fixture login');await command('/play',/Entered|play world|Survival|already/i);assert.equal(bot.game.gameMode,'survival')
 bot.loadPlugin(pathfinder);const movement=new Movements(bot),sx=Math.floor(status.playSpawn.x),sz=Math.floor(status.playSpawn.z),edge=sx<region.min.x?region.min.x:region.max.x
 movement.canDig=false;movement.allow1by1towers=false;movement.scafoldingBlocks=[];movement.allowParkour=false;movement.canOpenDoors=false;movement.entitiesToAvoid.add('player')
 movement.exclusionAreasBreak.push(()=>Infinity);movement.exclusionAreasPlace.push(()=>Infinity)
 movement.exclusionAreasStep.push(block=>{const p=block.position;return p.x>=region.min.x&&p.x<=region.max.x&&p.z>=region.min.z&&p.z<=region.max.z||p.x>=Math.min(sx,edge)&&p.x<=Math.max(sx,edge)&&Math.abs(p.z-sz)<=1||Math.abs(p.x-sx)<=2&&Math.abs(p.z-sz)<=2?0:Infinity})
 bot.pathfinder.setMovements(movement)
 bot.on('path_update',value=>{if(report.lastNavigation)report.lastNavigation.pathUpdate={status:value.status,nodes:value.path?.slice(0,4).map(point=>({x:point.x,y:point.y,z:point.z}))}})
 await enterPlot()
 if(!second)await command('/agent create',/CityAgent2 is your personal agent/)
 else {await command('/agent follow',/CityAgent2 will follow/);await command('/agent wait',/stopped and is waiting/)}
 const binding=await read(path.join(runtime,'personal-agents.json'));assert.equal(binding.agents.find(value=>value.name==='CityAgent1').ownerId,ruddy.ownerId);assert.equal(binding.agents.find(value=>value.name==='CityAgent2').ownerId,bot.player.uuid)
 await poll(()=>bot.players.CityAgent2?.entity,Boolean,'actual CityAgent2 visible')
 const currentSource=await chest(region.sourceChest),currentDestination=await chest(region.destinationChest),humanInventoryBefore=inventory()
 report.humanInventoryBefore=humanInventoryBefore
 const beforeSource=parent?parent.beforeSource:currentSource,beforeDestination=parent?parent.beforeDestination:currentDestination
 assert.ok((beforeSource.oak_planks||0)>=9,'Need nine existing planks; never restock')
 const retained=parent?parent.retainedBlocks:[]
 if(!parent)for(let x=region.min.x;x<=region.max.x;x++)for(let y=region.min.y-1;y<=region.max.y;y++)for(let z=region.min.z;z<=region.max.z;z++){const position=[x,y,z],block=bot.blockAt(new Vec3(...position));assert.ok(block,'Loaded native plot');if(!['air','cave_air','void_air'].includes(block.name))retained.push({position,material:block.name})}
 const relative=[[0,0,0],[2,0,0],[0,1,0],[2,1,0],[0,2,0],[1,2,0],[2,2,0]],offset=[5,0,6]
 const arch=relative.map(cell=>cell.map((n,i)=>n+offset[i]+region.origin[i])),resources=[[6,0,4],[7,0,4]].map(cell=>cell.map((n,i)=>n+region.origin[i]))
 if(parent){assert.deepEqual(arch,parent.expectedArch);assert.deepEqual(resources,parent.resources);assert.deepEqual(currentSource,{...beforeSource,oak_planks:beforeSource.oak_planks-2},'Exactly the original two source planks already withdrawn');assert.deepEqual(currentDestination,beforeDestination);assert.equal(humanInventoryBefore.oak_planks||0,0,'Actual rejoined player must hold zero planks before resuming');for(const block of retained)assert.equal(bot.blockAt(new Vec3(...block.position))?.name,block.material,'Preserve original retained world');for(const position of resources)assert.equal(bot.blockAt(new Vec3(...position))?.name,'oak_planks','Both original resource blocks must exist')}
 for(const position of [...arch,...(parent?[]:resources)])assert.equal(bot.blockAt(new Vec3(...position)).name,'air','Never overwrite a fixture cell')
 report.retainedBlocks=retained;report.expectedArch=arch;report.resources=resources;report.beforeSource=beforeSource;report.beforeDestination=beforeDestination
 check('unused-arch-and-resource-cells-retained-shelter-and-real-stock-preflight',{retainedBlocks:retained.length,existingPlanks:beforeSource.oak_planks})
 if(!parent){await chest(region.sourceChest,2)
 await walk([region.max.x,region.min.y,region.min.z],'Prepared north-east resource alignment');await walk([region.max.x,region.min.y,region.max.z-1],'Prepared resource-side perimeter')
 for(const [index,position] of resources.entries()){const target=new Vec3(...position);await walk(position,'Unused resource cell approach',2);await bounded(bot.equip(bot.inventory.items().find(item=>item.name==='oak_planks'),'hand'),5000,'Fixture plank equip');await bounded(bot.placeBlock(bot.blockAt(target.offset(0,-1,0)),new Vec3(0,1,0)),10000,'Native loose plank placement');await poll(()=>bot.blockAt(target)?.name,value=>value==='oak_planks','actual fixture plank placement');await poll(()=>inventory().oak_planks||0,value=>value===(humanInventoryBefore.oak_planks||0)+1-index,'Native player plank inventory acknowledgement',10000)}
 await poll(()=>inventory().oak_planks||0,value=>value===(humanInventoryBefore.oak_planks||0),'Exactly two withdrawn planks placed physically',10000)
 }else check('resume-original-two-resource-blocks-and-zero-player-planks-without-replay')
 await walk([region.max.x,region.min.y,region.max.z-1],'Prepared observer south-east perimeter');await walk([region.min.x+1,region.min.y,region.max.z-1],'Prepared observer west perimeter')
 const previousInspection=(await taskState()).inspections?.[bot.player.uuid]?.snapshot?.observedAt
 await command('/agent inspect',/Supplies|Observed|stock|checked/i)
 const inspected=await poll(async()=>{const entry=(await taskState()).inspections?.[bot.player.uuid];return entry?.status==='complete'?entry.snapshot:null},value=>Boolean(value&&value.observedAt!==previousInspection),'actual fresh native stock inspection')
 assert.equal(inspected.source.oak_planks,beforeSource.oak_planks-2)
 report.beforeInspection=inspected;check('direct-inspection-returns-fresh-native-inventory-and-stock')
 const priorIds=new Set((await taskState()).tasks.map(task=>task.id))
 const archRequest='Build a three-block-wide, three-block-high oak_planks arch, one block thick, at origin offset [5,0,6]. Leave the opening between its two pillars clear.'
 report.requests=[archRequest]
 await command('/agent task '+archRequest,/Task|plan|arch|structure|started|working/i)
 const built=await waitTasks(priorIds,['build_structure'],'exact custom arch complete')
 assert.ok(built.some(task=>task.plan.placements.length===7),'Actual seven-cell compiled custom plan')
 for(const position of arch)assert.equal(bot.blockAt(new Vec3(...position)).name,'oak_planks')
 report.archTasks=built;check('natural-language-seven-block-custom-arch-native-world-result')
 const afterArchIds=new Set((await taskState()).tasks.map(task=>task.id))
 const gatherRequest='Harvest 2 loose oak_planks blocks in your plot, craft 4 sticks from those 2 planks, then deliver the 4 carried sticks to your destination chest. No chest collection; preserve completed structures.'
 report.requests.push(gatherRequest)
 await command('/agent task '+gatherRequest,/Task|plan|gather|craft|started|working/i)
 const crafted=await waitTasks(afterArchIds,['gather','craft','deliver'],'real gather, four-stick craft and carried delivery complete')
 for(const position of resources)assert.ok(['air','cave_air','void_air'].includes(bot.blockAt(new Vec3(...position)).name))
 const craft=crafted.find(task=>task.plan.action==='craft');assert.equal(craft.plan.outputCount,4)
 const receipts=Object.values(craft.receipts||{}),last=receipts.find(receipt=>(receipt.after?.inventory?.stick||receipt.after?.inventory?.sticks||0)-(receipt.before?.inventory?.stick||receipt.before?.inventory?.sticks||0)===4)
 assert.ok(last,'Native craft receipt increases sticks by exactly four')
 const delivered=crafted.find(task=>task.plan.action==='deliver')
 const deposit=Object.values(delivered.receipts||{}).find(receipt=>(receipt.after?.chest?.stick||0)-(receipt.before?.chest?.stick||0)===4&&(receipt.before?.inventory?.stick||0)-(receipt.after?.inventory?.stick||0)===4)
 assert.ok(deposit,'Actual carried-stick deposit receipt; no source replacement')
 assert.ok(!Object.entries(delivered.receipts||{}).some(([key])=>key.endsWith(':withdraw')),'Four crafted sticks must not be withdrawn from source')
 report.gatherCraftTasks=crafted;check('native-two-real-plank-blocks-picked-up-crafted-four-sticks-and-deposited-carried-items')
 const afterSource=await chest(region.sourceChest),afterDestination=await chest(region.destinationChest)
 assert.equal(afterSource.oak_planks,beforeSource.oak_planks-9);assert.deepEqual(afterDestination,{...beforeDestination,stick:(beforeDestination.stick||0)+4})
 for(const block of retained)assert.equal(bot.blockAt(new Vec3(...block.position)).name,block.material,'Retained shelter/chests/floor changed')
 const afterBindings=await read(path.join(runtime,'personal-agents.json'));assert.equal(afterBindings.agents.find(value=>value.name==='CityAgent1').ownerId,ruddy.ownerId)
 report.afterSource=afterSource;report.afterDestination=afterDestination
 check('nine-existing-planks-accounted-retained-blocks-and-Ruddy-binding-preserved',{delivered:'Four sticks observed in destination chest; no discarded cargo'})
 assert.ok(Object.values(deposit.after.inventory).every(count=>count===0),'Only an empty fixture agent may be released')
 await command('/agent release',/CityAgent2 was released/)
 report.fixtureAgentReleasedEmpty=true
 check('empty-fixture-agent-released-through-owner-command-with-task-history-preserved')
 report.status='pass'
}
run().catch(error=>{report.error=error.message;process.exitCode=1}).finally(async()=>{if(bot&&!disconnected){bot.pathfinder?.setGoal(null);bot.quit('Disclosed autonomy fixture finished; journals retained')}report.messages=messages;report.finishedAt=new Date().toISOString();const file=process.env.AC_PLAYABLE_TEST_REPORT||path.join(root,'evidence/runs/playable-autonomy',report.runId,'report.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:file,error:report.error,checks:report.checks.length}))})
