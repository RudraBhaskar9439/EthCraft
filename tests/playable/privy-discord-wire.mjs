// Installed official SDK against an isolated local HTTP provider fixture.
// JWT claims are explicitly injected fixtures; this is not live OAuth evidence.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import vm from 'node:vm'
import {PrivyClient} from '../../backend/node_modules/@privy-io/node/index.mjs'
import {createDiscordIdentity} from '../../backend/src/discord/identity.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_privy_discord_wire_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.databaseUrl,max:1}),pool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema,max:3})
const discordId='111111111111111111',privySubject='did:privy:fixturewire',events=[],observed=[]
let accountDiscord='999999999999999999',created=false
const provider=createServer((req,res)=>{events.push('GET-user');observed.push({method:req.method,path:req.url,appId:req.headers['privy-app-id']});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:privySubject,created_at:1700000000,linked_accounts:[{type:'discord_oauth',subject:accountDiscord,username:'DisclosedFixture',verified_at:1700000000}],mfa_methods:[],has_accepted_terms:false,is_guest:false}))})
provider.listen(0,'127.0.0.1');await once(provider,'listening')
const report={status:'fail',scope:'Actual @privy-io/node0.37.0 HTTP wire against local fake provider plus isolated PG; fixture JWT claims, no live user or provider mutation',checks:[],publicTransactions:0,realProviderRequests:0}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 const sdk=new PrivyClient({appId:'fixture-app',appSecret:'fixture-not-a-real-secret',apiUrl:'http://127.0.0.1:'+provider.address().port,maxRetries:0,timeout:3000})
 await assert.rejects(sdk.users().get(privySubject))
 assert.equal(observed.length,0)
 const service=await createDiscordIdentity({pool,appId:'fixture-app',origin:'http://127.0.0.1:8789',serverId:'fixture',
  verifyPrivyToken:async()=>{events.push('verify-fixture-JWT');return{subject:privySubject,appId:'fixture-app',issuer:'privy.io',expiresAtMs:Date.now()+60000}},
  loadPrivyUser:subject=>sdk.users()._get(subject)})
 const challenge=await service.beginSetup({discordUserId:discordId,interactionId:'100000000000000001'})
 const input={challenge:challenge.challenge,accessToken:'fixture-token-not-real-OAuth-123456'}
 await assert.rejects(service.completeSetup(input),/PRIVY_VERIFIED_DISCORD_ACCOUNT_MISMATCH/)
 accountDiscord=discordId
 assert.equal((await service.completeSetup(input)).verified,true)
 assert.equal(observed.length,2)
 for(const request of observed){assert.equal(request.method,'GET');assert.equal(decodeURIComponent(request.path),'/v1/users/'+privySubject);assert.equal(request.appId,'fixture-app')}
 assert.deepEqual(events,['verify-fixture-JWT','GET-user','verify-fixture-JWT','GET-user'])
 pass('official SDK _get performs GET /v1/users/exact-DID after JWT verifier; get(string) is rejected and mismatched Discord subject stays refused')
 const jsx=await readFile(join(root,'companion/src/discord-setup.jsx'),'utf8')
 const source=jsx.slice(jsx.indexOf('function setupFailureMessage'),jsx.indexOf('function Setup('))
 const message=vm.runInNewContext(source+';setupFailureMessage')
 assert.match(message('DISCORD_SETUP_EXPIRED_OR_USED'),/fresh link/)
 assert.match(message('PRIVY_VERIFIED_DISCORD_ACCOUNT_MISMATCH'),/does not match/)
 assert.match(message('PRIVY_TOKEN_INVALID'),/Sign out/)
 assert.match(message('PRIVY_USER_LOOKUP_UNAVAILABLE'),/temporarily unavailable/)
 assert.match(message('LEGACY_OWNER_BINDING_CONFLICT'),/original account/)
 assert(!message('untrusted-private-token-fixture').includes('untrusted-private-token-fixture'))
 pass('setup UI safely distinguishes expired challenge wrong account invalid token provider outage and existing-owner conflict without echoing raw errors')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();const directory=join(root,'evidence/runs/privy-discord-wire',randomUUID());await mkdir(directory,{recursive:true});report.sources={};for(const file of ['backend/src/discord/identity.mjs','backend/src/discord/runtime.mjs','companion/src/discord-setup.jsx'])report.sources[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
