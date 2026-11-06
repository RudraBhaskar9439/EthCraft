// Terms-only isolated PostgreSQL fixtures; no Discord delivery or money movement.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createWorkOrders} from '../../backend/src/discord/work-orders.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),environment=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_discord_work_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:environment.databaseUrl,max:1}),pool=new Pool({connectionString:environment.databaseUrl,options:'-c search_path='+schema,max:3})
const report={status:'fail',scope:'Three focused terms-only isolated PostgreSQL fixtures; no external messages, execution, funding, escrow or payment',checks:[],moneyMoved:false,sourceSha256:createHash('sha256').update(await readFile(new URL('../../backend/src/discord/work-orders.mjs',import.meta.url))).digest('hex')}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query('CREATE TABLE ac_discord_identities(discord_user_id text PRIMARY KEY,principal_id uuid UNIQUE)')
 const requester=randomUUID(),executor=randomUUID(),outsider=randomUUID(),requesterDiscord='111111111111111111',executorDiscord='222222222222222222'
 await pool.query('INSERT INTO ac_discord_identities VALUES($1,$2),($3,$4)',[requesterDiscord,requester,executorDiscord,executor])
 const service=await createWorkOrders({pool,allowLegacyGameCoinsFixture:true})
 const input={interactionId:'fixture-request-1',requesterOwnerId:requester,targetOwnerId:executor,targetAgent:'CityAgent2',request:'Build an oak arch in the approved plot.',sourcedDiscordId:requesterDiscord}
 const work=await service.createRequest(input)
 await assert.rejects(service.createRequest({...input,interactionId:'wrong-discord',sourcedDiscordId:executorDiscord}),/WORK_DISCORD_ACTOR_BINDING_REQUIRED/)
 await assert.rejects(service.proposeQuote({workId:work.workId,actorOwnerId:requester,price:'7',asset:'GAME_COINS'}),/WORK_EXECUTOR_OWNER_QUOTE_REQUIRED/)
 await assert.rejects(service.proposeQuote({workId:work.workId,actorOwnerId:executor,price:'7',asset:'GAME_COINS',actorKind:'agent',agentId:'CityAgent2'}),/EXPLICIT_OWNER_AGENT_QUOTE_POLICY_REQUIRED/)
 await assert.rejects(service.get({workId:work.workId,actorOwnerId:outsider}),/WORK_PARTICIPANT_REQUIRED/)
 assert.equal((await service.list({actorOwnerId:outsider})).length,0)
 pass('verified Discord requester and exact executor ownership required; unapproved autonomous bids and foreign inbox access refused')

 assert.equal((await service.createRequest(input)).workId,work.workId)
 await assert.rejects(service.createRequest({...input,request:'Silently changed request'}),/WORK_REQUEST_IMMUTABLE_TERMS/)
 const quoteInput={workId:work.workId,actorOwnerId:executor,price:'1.250',asset:'CITY',materials:{oak_planks:7},scope:'Three-wide oak arch; materials supplied by requester.'}
 const first=await service.proposeQuote(quoteInput)
 assert.equal(first.price,'1.25');assert.equal(first.amountBaseUnits,'1250000000000000000')
 assert.equal((await service.proposeQuote(quoteInput)).quoteId,first.quoteId)
 const second=await service.proposeQuote({...quoteInput,price:'2'})
 assert.equal(second.version,2);assert.notEqual(second.digest,first.digest)
 await assert.rejects(service.acceptQuote({workId:work.workId,actorOwnerId:requester,quoteId:first.quoteId,digest:first.digest}),/WORK_QUOTE_REVISED_OR_CLOSED/)
 await assert.rejects(service.acceptQuote({workId:work.workId,actorOwnerId:requester,quoteId:second.quoteId,digest:'0'.repeat(64)}),/WORK_QUOTE_DIGEST_MISMATCH/)
 await assert.rejects(pool.query("UPDATE ac_discord_work_quotes SET terms='{}' WHERE quote_id=$1",[first.quoteId]),/WORK_QUOTE_VERSION_IMMUTABLE/)
 await assert.rejects(pool.query('UPDATE ac_discord_work_requests SET requester_id=$2 WHERE id=$1',[work.workId,outsider]),/WORK_REQUEST_ACCEPTED_TERMS_IMMUTABLE/)
 pass('immutable quote versions bind exact parties specification price units materials scope deadline and digest; stale acceptance refused')

 await assert.rejects(service.acceptQuote({workId:work.workId,actorOwnerId:executor,quoteId:second.quoteId,digest:second.digest}),/WORK_REQUESTER_ACCEPTANCE_REQUIRED/)
 const accepted=await service.acceptQuote({workId:work.workId,actorOwnerId:requester,quoteId:second.quoteId,digest:second.digest})
 assert.equal(accepted.state,'terms_accepted_awaiting_funding');assert.equal(accepted.executionAuthorized,false);assert.equal(accepted.funded,false);assert.equal(accepted.paid,false)
 assert.deepEqual(await service.acceptQuote({workId:work.workId,actorOwnerId:requester,quoteId:second.quoteId,digest:second.digest}),accepted)
 await assert.rejects(service.acceptQuote({workId:work.workId,actorOwnerId:requester,quoteId:first.quoteId,digest:first.digest}),/WORK_ACCEPTANCE_IMMUTABLE_TERMS/)
 await assert.rejects(service.proposeQuote({...quoteInput,price:'3'}),/WORK_TERMS_ALREADY_CLOSED/)
 const approved=await createWorkOrders({pool,allowLegacyGameCoinsFixture:true,authorizeAgentQuote:async input=>({allowed:true,ownerId:input.actorOwnerId,agentId:input.agentId,policyId:'fixture-owner-approved-policy',expiresAt:new Date(Date.now()+3600000).toISOString()})})
 const agentWork=await approved.createRequest({...input,interactionId:'fixture-agent-bid'})
 const agentQuote=await approved.proposeQuote({workId:agentWork.workId,actorOwnerId:executor,price:'5',asset:'GAME_COINS',actorKind:'agent',agentId:'CityAgent2'})
 assert.equal(agentQuote.actorKind,'agent');assert.equal(agentQuote.authorOwnerId,executor)
 const declined=await approved.decline({workId:agentWork.workId,actorOwnerId:requester,quoteId:agentQuote.quoteId,reason:'Terms declined.'})
 assert.equal(declined.state,'declined');assert.equal(declined.terminalReceipt.moneyMoved,false)
 const cancelled=await service.cancel({workId:work.workId,actorOwnerId:requester,reason:'Cancel before any funding.'})
 assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.terminalReceipt.moneyMoved,false)
 const onchain=await createWorkOrders({pool}),newWork=await onchain.createRequest({...input,interactionId:'fixture-onchain-only'})
 await assert.rejects(onchain.proposeQuote({workId:newWork.workId,actorOwnerId:executor,price:'5',asset:'GAME_COINS',scope:'Retired quote'}),/GAME_COINS_RETIRED/)
 const cityQuote=await onchain.proposeQuote({workId:newWork.workId,actorOwnerId:executor,price:'5',scope:'Exact CITY work quote'})
 assert.equal(cityQuote.asset,'CITY');assert.equal((await onchain.get({workId:newWork.workId,actorOwnerId:requester})).funded,false)
 pass('default work quotes use CITY, reject retired currency and remain unfunded proposals without execution authority')
 assert.equal((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE '%wallet%'",[schema])).rows[0].count,'0')
 pass('requester acceptance replays identical terms awaiting funding only; explicit owner policy enables proposals and cancellation never pays or executes')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();const directory=join(root,'evidence/runs/discord-work-orders',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
