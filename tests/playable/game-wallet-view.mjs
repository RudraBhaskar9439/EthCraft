import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createGameWalletView} from '../../backend/src/discord/game-wallet-view.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_game_wallet_view_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.databaseUrl,max:1}),pool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema,max:2})
const report={status:'fail',scope:'Read-only game wallet lookup with isolated PostgreSQL fixtures; no real user/provider/session mutation',checks:[],walletWrites:0,signatures:0,publicTransactions:0,sourceSha256:createHash('sha256').update(await readFile(new URL('../../backend/src/discord/game-wallet-view.mjs',import.meta.url))).digest('hex')}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query(`CREATE TABLE ac_discord_minecraft_aliases(server_id text,player_id uuid,principal_id uuid,connection_id uuid);
 CREATE TABLE ac_discord_join_approvals(server_id text,player_id uuid,principal_id uuid,connection_id uuid,status text);
 CREATE TABLE ac_discord_wallet_aliases(wallet_id text,principal_id uuid,address text,provider_account_id text);
 CREATE TABLE ac_playable_testnet_wallets(wallet_id text,environment text,address text,provider_type text,provider_account_id text,auth_subject_hash text)`)
 const ownerId=randomUUID(),playerId=randomUUID(),connectionId=randomUUID(),privySubject='did:privy:fixturegamewallet',address='0x0000000000000000000000000000000000005678',walletId='UNICHAIN_SEPOLIA_PLAYABLE:'+ownerId
 await pool.query('INSERT INTO ac_discord_minecraft_aliases VALUES($1,$2,$3,$4)',['fixture',playerId,ownerId,connectionId])
 await pool.query("INSERT INTO ac_discord_join_approvals VALUES($1,$2,$3,$4,'approved')",['fixture',playerId,ownerId,connectionId])
 await pool.query('INSERT INTO ac_discord_wallet_aliases VALUES($1,$2,$3,$4)',[walletId,ownerId,address,'fixture-provider-wallet'])
 await pool.query("INSERT INTO ac_playable_testnet_wallets VALUES($1,'UNICHAIN_SEPOLIA_PLAYABLE',$2,'privy',$3,$4)",[walletId,address,'fixture-provider-wallet',createHash('sha256').update(privySubject).digest('hex')])
 const owner={ownerId,ownerName:'DisclosedFixture',minecraftPlayerId:playerId,privySubject}
 const current={online:true,pendingAuthentication:false,serverId:'fixture',playerId,connectionId,principalId:ownerId,playerName:owner.ownerName}
 let mapped=true,reads=0
 const view=createGameWalletView({pool:{query:(sql,args)=>{assert.match(sql,/^\s*SELECT\b/i);reads++;return pool.query(sql,args)}},serverId:'fixture',
  identity:{getMinecraftOwner:async(server,id)=>{assert.equal(server,'fixture');assert.equal(id,playerId);if(!mapped)throw Object.assign(Error('unmapped'),{code:'MINECRAFT_ALIAS_NOT_LINKED'});return owner}},gameSession:async()=>current})
 const event={playerId,connectionId},before=(await pool.query('SELECT * FROM ac_playable_testnet_wallets')).rows
 owner.ownerName=owner.ownerName.toLowerCase()
 const result=await view(event)
 assert.notEqual(ownerId,playerId);assert.equal(result.address,address);assert.equal(result.ownerId,ownerId);assert.equal(result.spendingAuthorized,false)
 assert.equal(result.ready,true);assert.equal(result.mapped,true);assert.equal(reads,2)
 assert.deepEqual((await pool.query('SELECT * FROM ac_playable_testnet_wallets')).rows,before)
 pass('different canonical and Minecraft UUIDs resolve the existing approved Discord wallet using SELECT-only reads with zero provisioning or financial authority')
 current.principalId=randomUUID();await assert.rejects(view(event),/DISCORD_GAME_WALLET_APPROVED_CONNECTION_REQUIRED/);current.principalId=ownerId
 await assert.rejects(view({...event,connectionId:randomUUID()}),/DISCORD_GAME_WALLET_APPROVED_CONNECTION_REQUIRED/)
 current.pendingAuthentication=true;await assert.rejects(view(event),/DISCORD_GAME_WALLET_APPROVED_CONNECTION_REQUIRED/);current.pendingAuthentication=false
 await pool.query('UPDATE ac_discord_minecraft_aliases SET connection_id=$1',[randomUUID()])
 await assert.rejects(view(event),/DISCORD_GAME_WALLET_ALIAS_APPROVAL_REQUIRED/)
 await pool.query('UPDATE ac_discord_minecraft_aliases SET connection_id=$1',[connectionId])
 pass('wrong principal stale event pending join and missing exact approved alias connection refuse wallet disclosure')
 await pool.query('DELETE FROM ac_discord_wallet_aliases')
 const missing=await view(event);assert.equal(missing.mapped,true);assert.equal(missing.ready,false);assert.match(missing.message,/Discord/);assert(!missing.message.includes('player-wallet'))
 mapped=false;assert.deepEqual(await view(event),{mapped:false})
 assert.equal((await pool.query('SELECT count(*) FROM ac_playable_testnet_wallets')).rows[0].count,'1')
 assert.equal((await pool.query("SELECT to_regclass('ac_wallet_verified_sessions') AS name")).rows[0].name,null)
 pass('missing account directs setup to Discord without creating wallets or old game-auth sessions while unmapped identity permits explicit legacy routing')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();const directory=join(root,'evidence/runs/game-wallet-view',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
