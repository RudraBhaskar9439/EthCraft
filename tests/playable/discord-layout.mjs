import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { Collection, PermissionFlagsBits as P, PermissionsBitField } from '../../backend/node_modules/discord.js/src/index.js'
import { createDiscordServerLayout } from '../../backend/src/discord/server-layout.mjs'

const runId=randomUUID(),schema='discord_layout_fixture_'+runId.replaceAll('-',''),root=new URL('../../',import.meta.url)
const config=JSON.parse(await readFile(new URL('.local/backend/environment.json',root),'utf8'))
const admin=new pg.Pool({connectionString:config.databaseUrl,max:1}),pool=new pg.Pool({connectionString:config.databaseUrl,options:'-c search_path='+schema,max:4})
const report={status:'fail',scope:'Actual isolated PostgreSQL; simulated Discord guild/API only; zero external channel writes or Gateway connections',checks:[]}
const check=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const guildId='770000000000000001',bot='880000000000000001',owner='660000000000000001',other='660000000000000002',agentBot='880000000000000002',roleId='550000000000000001'
const channels=new Collection(),roles=new Collection([[guildId,{id:guildId}],[roleId,{id:roleId}]])
let allowed=true,nextId=990000000000000000n,creates=0,edits=0,sends=0,unknownCreate=false,unknownEdit=false
const members=new Map([[bot,{id:bot,user:{bot:true}}],[owner,{id:owner,user:{bot:false}}],[other,{id:other,user:{bot:false}}],[agentBot,{id:agentBot,user:{bot:true}}]])
members.get(bot).permissions={has:()=>allowed}
function apply(channel,payload){channel.name=payload.name;channel.parentId=payload.parent;channel.permissionOverwrites={cache:new Collection(payload.permissionOverwrites.map(entry=>[entry.id,{...entry,allow:new PermissionsBitField(entry.allow),deny:new PermissionsBitField(entry.deny)}]))}}
const guild={id:guildId,members:{fetch:async id=>{assert(members.has(id));return members.get(id)}},roles:{fetch:async()=>roles},channels:{fetch:async id=>channels.get(id),create:async payload=>{creates++;if(unknownCreate)throw Error('SIMULATED_UNCERTAIN_API_RESULT');const channel={id:String(++nextId),guildId,type:payload.type,edit:async data=>{edits++;apply(channel,data);if(unknownEdit){unknownEdit=false;throw Error('SIMULATED_UNCERTAIN_EDIT_RESULT')}return channel},send:async()=>{sends++;return{id:'fixture-message'}}};apply(channel,payload);channels.set(channel.id,channel);return channel}}}
const layout=createDiscordServerLayout({pool,guild,coordinatorBotId:bot,serverId:'layout-fixture'})
const agents=[{slotName:'CityAgent1',ownerDiscordId:owner,agentBotId:agentBot}]
try{
 await admin.query('CREATE SCHEMA '+schema);await layout.initialize()
 allowed=false;const denied=await layout.reconcile({agents});assert.equal(denied.ok,false);assert.deepEqual(denied.missingPermissions,['ManageChannels','ManageRoles','ViewChannel','SendMessages']);assert.equal(creates,0);assert.equal(edits,0);allowed=true
 check('permission preflight reports exact missing permissions before any Discord write')
 const initial=await layout.reconcile({agents});assert.equal(initial.ok,true);assert.equal(creates,10);assert.equal(initial.administratorVisibility,true)
 const originalIds=[...channels.keys()],again=await layout.reconcile({agents});assert.deepEqual(again.channels,initial.channels);assert.equal(creates,10);assert.deepEqual([...channels.keys()],originalIds)
 const publicBoard=channels.get(initial.channels.jobs);assert(publicBoard.permissionOverwrites.cache.get(guildId).deny.has(P.SendMessages));assert(publicBoard.permissionOverwrites.cache.get(roleId).deny.has(P.SendMessages));assert(channels.get(initial.channels['general-chat']).permissionOverwrites.cache.get(guildId).allow.has(P.SendMessages))
 check('categories and six public channels reconcile by durable IDs without duplicate creation; boards readonly and general chat writable')
 const privateId=initial.channels.CityAgent1,memberIds=[owner,bot,agentBot].sort();assert.equal(initial.agentRooms.CityAgent1,privateId);assert.deepEqual(await layout.getRoom('CityAgent1'),{channelId:privateId,memberIds,administratorVisibility:true});await layout.sendPrivate({channelId:privateId,memberIds,payload:{content:'fixture private'}});assert.equal(sends,1)
 await assert.rejects(layout.sendPrivate({channelId:privateId,memberIds:[other,bot,agentBot],payload:{content:'must not send'}}),/PRIVATE_AUTHORITY_MISMATCH/);assert.equal(sends,1)
 const room=channels.get(privateId);room.permissionOverwrites.cache.get(roleId).deny.remove(P.ViewChannel)
 await assert.rejects(layout.sendPrivate({channelId:privateId,memberIds,payload:{content:'must not send'}}),/PRIVATE_ACL_UNSAFE/);assert.equal(sends,1)
 await layout.reconcile({agents});await layout.assertPrivateRoom({channelId:privateId,memberIds})
 check('private rooms deny every role, permit only exact owner/coordinator/own bot, and recheck live ACL before private sends')
 const job=await layout.privateJobRoom({jobId:'fixture-job',participantDiscordIds:[owner,other],agentBotIds:[agentBot]});assert(job.ok);assert.equal(creates,11)
 const jobAgain=await layout.privateJobRoom({jobId:'fixture-job',participantDiscordIds:[owner,other],agentBotIds:[agentBot]});assert.equal(jobAgain.channelId,job.channelId);assert.equal(creates,11)
 await assert.rejects(layout.privateJobRoom({jobId:'fixture-job',participantDiscordIds:[other],agentBotIds:[agentBot]}),/MEMBERSHIP_CHANGE_REQUIRES_OPERATOR_REVIEW/)
 check('private job rooms bind immutable participant sets and retry without adopting unrelated named channels')
 unknownCreate=true;await assert.rejects(layout.privateJobRoom({jobId:'uncertain-job',participantDiscordIds:[owner]}),/UNCERTAIN_API_RESULT/);const attempts=creates;unknownCreate=false
 await assert.rejects(layout.privateJobRoom({jobId:'uncertain-job',participantDiscordIds:[owner]}),/UNCERTAIN_CREATE_REQUIRES_OPERATOR_REVIEW/);assert.equal(creates,attempts)
 check('uncertain channel create persists marker and refuses duplicate retry')
 const future={slotName:'FutureAgent_33',ownerDiscordId:owner},retryAgent={slotName:'FutureAgent_34',ownerDiscordId:owner}
 await layout.reconcile({agents:[...agents,future,retryAgent]})
 await assert.rejects(layout.addAgentBot({slotName:future.slotName,ownerDiscordId:other,agentBotId:agentBot}),/MEMBERSHIP_CHANGE_REQUIRES_OPERATOR_REVIEW/)
 await assert.rejects(layout.addAgentBot({slotName:future.slotName,ownerDiscordId:owner,agentBotId:other}),/AGENT_BOT_MEMBERSHIP_INVALID/)
 const upgraded=await layout.addAgentBot({slotName:future.slotName,ownerDiscordId:owner,agentBotId:agentBot});assert(upgraded.ok);assert.deepEqual(upgraded.memberIds,memberIds)
 assert.equal((await layout.addAgentBot({slotName:future.slotName,ownerDiscordId:owner,agentBotId:agentBot})).channelId,upgraded.channelId)
 await layout.sendPrivate({channelId:upgraded.channelId,memberIds,payload:{content:'fixture bot membership upgraded'}})
 check('generic registered agent rooms support owner-preserving verified-bot addition, with foreign owner and human-as-bot refused')
 unknownEdit=true;await assert.rejects(layout.addAgentBot({slotName:retryAgent.slotName,ownerDiscordId:owner,agentBotId:agentBot}),/UNCERTAIN_EDIT_RESULT/)
 assert.equal(await layout.getRoom(retryAgent.slotName),null)
 const pending=(await pool.query(`SELECT channel_id FROM ac_discord_layout WHERE resource_key=$1`,['agent:'+retryAgent.slotName])).rows[0]
 await assert.rejects(layout.sendPrivate({channelId:pending.channel_id,memberIds,payload:{content:'must not send while uncertain'}}),/PRIVATE_AUTHORITY_MISMATCH/)
 await layout.reconcile({agents:[...agents,{...future,agentBotId:agentBot},{...retryAgent,agentBotId:agentBot}]});assert.deepEqual((await layout.getRoom(retryAgent.slotName)).memberIds,memberIds)
 check('uncertain bot-add outcome blocks private delivery until exact owner-preserving target ACL reconciles')
 report.status='pass'
}catch(error){report.error={message:error.message,code:error.code};process.exitCode=1}finally{
 report.discordWritesAreFixtures=true;report.actualPublicWrites=0;report.finishedAt=new Date().toISOString();const dir=new URL('evidence/runs/discord-layout/'+runId+'/',root);await mkdir(dir,{recursive:true});await writeFile(new URL('report.json',dir),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:dir.pathname,error:report.error}));await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end()
}
