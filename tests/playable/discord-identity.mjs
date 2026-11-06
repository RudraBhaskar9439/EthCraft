// Isolated PostgreSQL fixtures. No real Discord, Privy, Minecraft or wallet mutations.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createDiscordIdentity} from '../../backend/src/discord/identity.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),environment=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_discord_identity_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:environment.databaseUrl,max:1})
const pool=new Pool({connectionString:environment.databaseUrl,options:'-c search_path='+schema,max:4})
const report={status:'fail',scope:'Focused isolated PostgreSQL fixtures only; no real external identity or wallet creation',checks:[],walletWrites:0,publicTransactions:0,sourceSha256:createHash('sha256').update(await readFile(new URL('../../backend/src/discord/identity.mjs',import.meta.url))).digest('hex')}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query(`CREATE TABLE ac_wallet_identity_bindings(player_id uuid PRIMARY KEY,player_name text,privy_subject text,app_id text);
 CREATE TABLE ac_playable_testnet_wallets(wallet_id text PRIMARY KEY,address text,provider_account_id text,auth_subject_hash text)`)
 const legacyId=randomUUID(),legacySubject='did:privy:fixturelegacy',legacyWallet={wallet_id:'UNICHAIN_SEPOLIA_PLAYABLE:'+legacyId,address:'0x0000000000000000000000000000000000001234',provider_account_id:'fixture-existing-wallet',auth_subject_hash:createHash('sha256').update(legacySubject).digest('hex')}
 await pool.query('INSERT INTO ac_wallet_identity_bindings VALUES($1,$2,$3,$4)',[legacyId,'LegacyFixture',legacySubject,'fixture-app'])
 await pool.query('INSERT INTO ac_playable_testnet_wallets VALUES($1,$2,$3,$4)',Object.values(legacyWallet))
 const people=new Map(),claims=new Map(),actualSession={online:true,serverId:'fixture',playerId:randomUUID(),connectionId:randomUUID(),playerName:'NewFixture'}
 let approveEffects=0,loseApproval=true,approvedReceipt,scopeOwner,reservedJoin
 const service=await createDiscordIdentity({pool,appId:'fixture-app',origin:'http://127.0.0.1:8789',serverId:'fixture',
  verifyPrivyToken:async token=>claims.get(token),loadPrivyUser:async subject=>people.get(subject),gameSession:async()=>actualSession,
  approveJoin:async input=>{if(!approvedReceipt){approveEffects++;approvedReceipt={...input,approved:true}}if(loseApproval){loseApproval=false;throw Error('fixture lost join approval reply')}return approvedReceipt},
  reserveJoin:async input=>{reservedJoin=input},
  resolveScope:async input=>input.ownerId===scopeOwner&&input.agentId==='CityAgent2'&&input.plotId==='CityAgent2'})
 const register=async(discordUserId,privySubject,interactionId)=>{
  const token='fixture-token-'+randomUUID();claims.set(token,{subject:privySubject,appId:'fixture-app',issuer:'privy.io',expiresAtMs:Date.now()+3600000})
  people.set(privySubject,{id:privySubject,linked_accounts:[{type:'discord_oauth',subject:discordUserId,verified_at:1700000000}]})
  const challenge=await service.beginSetup({discordUserId,interactionId})
  assert.equal(new URL(challenge.loginUrl).pathname,'/discord/setup')
  return{token,challenge,complete:()=>service.completeSetup({challenge:challenge.challenge,accessToken:token})}
 }
 const newcomer=await register('111111111111111111','did:privy:fixturenew','100000000000000001')
 people.get('did:privy:fixturenew').linked_accounts[0].subject='999999999999999999'
 await assert.rejects(newcomer.complete(),/PRIVY_VERIFIED_DISCORD_ACCOUNT_MISMATCH/)
 people.get('did:privy:fixturenew').linked_accounts[0].subject='111111111111111111'
 const linked=await newcomer.complete();assert.equal(linked.verified,true)
 await assert.rejects(newcomer.complete(),/DISCORD_SETUP_EXPIRED_OR_USED/)
 await assert.rejects(service.getOwner('999999999999999999'),/DISCORD_PRIVY_LINK_REQUIRED/)
 assert.equal((await pool.query('SELECT count(*) FROM ac_discord_minecraft_aliases')).rows[0].count,'0')
 pass('Discord setup requires verified matching Privy OAuth subject consumes opaque challenge once and creates no fake Minecraft identity')

 const old=await register('222222222222222222',legacySubject,'100000000000000002')
 assert.equal((await old.complete()).ownerId,legacyId)
 const oldOwner=await service.getOwner('222222222222222222');assert.equal(oldOwner.minecraftPlayerId,legacyId)
 assert.deepEqual((await pool.query('SELECT * FROM ac_playable_testnet_wallets')).rows[0],legacyWallet)
 assert.equal((await pool.query('SELECT * FROM ac_discord_wallet_aliases')).rows[0].address,legacyWallet.address)
 await assert.rejects(service.reserveMinecraft({discordUserId:'111111111111111111',playerName:'LegacyFixture'}),/MINECRAFT_ALIAS_OWNER_CONFLICT|EXISTING_MINECRAFT_OWNER_LOGIN_REQUIRED/)
 pass('existing funded wallet row address provider ID and legacy owner UUID remain unchanged while Discord adds aliases')

 const reservation=await service.reserveMinecraft({discordUserId:'111111111111111111',playerName:'newfixture',accountKind:'microsoft'})
 assert.equal(reservation.verification,'microsoft_pending')
 assert.equal(reservedJoin.accountKind,'microsoft');assert(Number.isSafeInteger(reservedJoin.expiresAtMs));assert.equal(reservedJoin.principalId,reservation.ownerId)
 await assert.rejects(service.reserveMinecraft({discordUserId:'111111111111111111',playerName:'NewFixture',accountKind:'local'}),/MINECRAFT_ACCOUNT_KIND_MIGRATION_REQUIRES_REVIEW/)
 const owner=await service.getOwner('111111111111111111');scopeOwner=owner.ownerId
 assert.notEqual(owner.ownerId,actualSession.playerId);assert.equal(owner.minecraftLinked,false)
 const grantInput={discordUserId:'111111111111111111',slotName:'CityAgent2',tools:['status','inspect','screenshot','build','gather','craft','deliver'],ttlMs:3600000,operationId:'fixture-stable-grant'}
 const grant=await service.issueGrant(grantInput)
 await new Promise(resolve=>setTimeout(resolve,10))
 assert.deepEqual(await service.issueGrant(grantInput),grant)
 await assert.rejects(service.issueGrant({...grantInput,tools:['status']}),/REMOTE_GRANT_IMMUTABLE_TERMS/)
 assert.equal((await service.authorizeGrant({discordUserId:'111111111111111111',grantId:grant.id,ownerId:owner.ownerId,slotName:'CityAgent2',action:'build_structure'})).ownerPlayerId,owner.ownerId)
 assert.equal((await service.getOwner('111111111111111111')).minecraftLinked,false)
 pass('verified Discord owner receives bounded own-agent physical grant before first Minecraft join without inventing a live connection')

 await assert.rejects(service.approveMinecraftJoin({discordUserId:'111111111111111111',playerId:actualSession.playerId,connectionId:randomUUID()}),/MINECRAFT_CONNECTION_BINDING_MISMATCH/)
 const approval={discordUserId:'111111111111111111',playerId:actualSession.playerId,connectionId:actualSession.connectionId}
 actualSession.playerName='OtherFixture'
 await assert.rejects(service.approveMinecraftJoin(approval),/MINECRAFT_CONNECTION_BINDING_MISMATCH/)
 actualSession.playerName='NewFixture'
 await assert.rejects(service.approveMinecraftJoin(approval),/fixture lost join approval reply/)
 await assert.rejects(service.approveMinecraftJoin({...approval,connectionId:randomUUID()}),/JOIN_APPROVAL_ORIGINAL_CONNECTION_REQUIRED/)
 assert.equal((await service.approveMinecraftJoin(approval)).approved,true)
 assert.equal((await service.approveMinecraftJoin(approval)).approved,true);assert.equal(approveEffects,1)
 const minecraftOwner=await service.getMinecraftOwner('fixture',actualSession.playerId)
 assert.equal(minecraftOwner.ownerId,owner.ownerId);assert.equal(minecraftOwner.minecraftVerification,'microsoft_pending')
 pass('reserved name ignores case while exact connection and different-name checks remain enforced; lost receipt reconciles once without claiming Microsoft verification')

 await assert.rejects(service.authorizeGrant({discordUserId:'222222222222222222',grantId:grant.id,action:'build'}),/REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE/)
 await assert.rejects(service.issueGrant({discordUserId:'111111111111111111',slotName:'CityAgent2',tools:['swap'],ttlMs:3600000}),/BOUNDED_REMOTE_GRANT_REQUIRED/)
 await assert.rejects(service.revokeRemote({discordUserId:'222222222222222222',grantId:grant.id}),/REMOTE_GRANT_OWNER_REQUIRED/)
 await service.revokeRemote({discordUserId:'111111111111111111',grantId:grant.id})
 await assert.rejects(service.issueGrant(grantInput),/REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE/)
 await assert.rejects(service.authorizeGrant({discordUserId:'111111111111111111',grantId:grant.id,action:'build'}),/REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE/)
 const expired=await service.issueGrant({discordUserId:'111111111111111111',slotName:'CityAgent2',tools:['status'],ttlMs:3600000})
 await pool.query("UPDATE ac_discord_remote_grants SET expires_at=now()-interval '1 second' WHERE grant_id=$1",[expired.id])
 await assert.rejects(service.authorizeGrant({discordUserId:'111111111111111111',grantId:expired.id,action:'status'}),/REMOTE_GRANT_EXPIRED_REVOKED_OR_OUT_OF_SCOPE/)
 pass('remote grants refuse another owner financial tools expiry and revocation without granting wallet spending')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();const directory=join(root,'evidence/runs/discord-identity',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
