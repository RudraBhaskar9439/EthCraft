// Read-only live host, Discord and existing-account verification. No signing.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import pg from '../backend/node_modules/pg/lib/index.js'
const root=fileURLToPath(new URL('../',import.meta.url)),json=async path=>JSON.parse(await readFile(path,'utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const platformPath=path=>process.platform==='win32'&&path.startsWith('/home/')?'\\\\wsl.localhost\\Ubuntu'+path.replaceAll('/','\\'):path
const active=await json(join(root,'.local/playable-world/active.json'));assert.equal(active.owner,'agentcity-playable-pilot')
const runtime=join(root,'.local/playable-world',active.container),token=(await readFile(join(runtime,'api-token'),'utf8')).trim(),manifest=await json(join(root,'.local/world-assets/asset-market.json'))
const report={status:'fail',observedAt:new Date().toISOString(),scope:'Actual installed native plugin, confirmed ownership projection, Discord controls and pre-upgrade Game Coin balance readback; zero wallet signatures, grants, user inventory changes or independent-human trades',checks:[]}
let pool
try{
 const api=async(path,body={})=>{const response=await fetch('http://127.0.0.1:25597/playable/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});assert(response.ok,'native endpoint '+path);return response.json()}
 const native=await api('escrow/status'),property=await api('property/status');assert.equal(native.pendingCount,0);assert.equal(property.active,true);assert(property.revision>0);assert(property.expiresAtMs>Date.now());assert.equal(property.catalog.length,4)
 assert.equal(property.source.registry.toLowerCase(),manifest.registry.toLowerCase());assert.equal(property.source.deploymentId,manifest.deploymentId);assert.equal(property.source.codeHash,manifest.codeHashes.registry);assert.equal(property.source.chainId,1301)
 assert.equal(property.projection.confirmed,true);assert(property.projection.confirmations>=2);assert.equal(property.projection.parcels.length,4)
 report.checks.push('installed native escrow has no unresolved inventory effect; four estate rows apply fresh confirmed chain source pins')
 const source=hash(await readFile(join(runtime,'plugins/AgentCity.jar')));assert.equal(source,'c9a108690fad15f8d15702b6d6c67468dab438c6ba5d6837fbf0938b28c02a69');report.pluginSha256=source
 const deps=await json(join(root,'config/property-dependencies.json'));for(const dependency of deps.artifacts)assert.equal(hash(await readFile(join(runtime,'plugins',dependency.file))),dependency.sha256)
 report.checks.push('installed application and both protection dependencies match the actual tested release hashes')
 const db=await json(join(root,'.local/backend/environment.json'));pool=new pg.Pool({connectionString:db.databaseUrl,max:1})
 const backup=await json(join(root,'.local/market-upgrade-backup.json')),backupManifest=await json(platformPath(backup.backupDirectory+'/manifest.json'))
 const players=(await pool.query('SELECT player_id,player_name,available::text,held::text FROM ac_game_players ORDER BY player_id')).rows
 assert.equal(hash(Buffer.from(JSON.stringify(players))),backupManifest.gameAccountSnapshotSha256);report.originalGameAccountsUnchanged=players.length
 const preserved={};for(const[file,before]of Object.entries(backup.originalFiles))if(file!=='plugins/AgentCity.jar')preserved[file]=hash(await readFile(join(runtime,file)))===before
 assert(Object.values(preserved).every(Boolean));report.originalJournalsPreserved=preserved
 report.checks.push('pre-upgrade Game Coin accounts and original personal-agent/task/lock journals retain their exact snapshots')
 const migration=await json(join(root,'.local/world-assets/player-policy-migration.json')),settings=await json(join(root,'.local/playable-testnet/wallet-settings.json'))
 assert.equal(settings.policyId,migration.newPolicyId);assert.equal(settings.policySha256,migration.newSha256)
 const migrated=(await pool.query("SELECT count(*)::int value FROM ac_world_asset_policy_migrations WHERE new_sha256=$1 AND status='confirmed'",[migration.newSha256])).rows[0].value
 assert.equal(migrated,migration.migratedWallets);report.migratedExistingWallets=migrated
 report.checks.push('versioned Privy migration and current configuration agree for all existing managed-wallet identities')
 const discord=await json(join(root,'.local/discord/settings.json')),credentials=await json(platformPath(discord.credentialsFile))
 const get=async path=>{const response=await fetch('https://discord.com/api/v10/'+path,{headers:{Authorization:'Bot '+credentials.botToken,'User-Agent':'AgentCityHost/1.0'},signal:AbortSignal.timeout(15000)});assert(response.ok,'Discord readback endpoint');return response.json()}
 const commands=await get('applications/'+discord.applicationId+'/guilds/'+discord.guildId+'/commands'),command=commands.find(value=>value.name==='assets');assert(command)
 const choices=command.options.find(value=>value.name==='action').choices.map(value=>value.value)
 for(const action of ['register_item','claim_land','snapshot','list','buy','redeem','fund','swap','retry'])assert(choices.includes(action))
 report.checks.push('actual guild slash command offers equipment, estate, funding, listing, purchase, redemption, swap and recovery actions')
 const channels=await get('guilds/'+discord.guildId+'/channels'),market=channels.find(value=>value.name==='marketplace'),transactions=channels.find(value=>value.name==='transactions');assert(market&&transactions)
 for(const channel of [market,transactions]){const everyone=channel.permission_overwrites.find(value=>value.id===discord.guildId);assert(BigInt(everyone.deny)&2048n)}
 const messages=await get('channels/'+market.id+'/messages?limit=100'),own=messages.filter(value=>value.author.id===discord.applicationId),guides=own.filter(value=>value.embeds?.some(embed=>embed.footer?.text==='AgentCity · marketplace-guide'))
 assert.equal(guides.length,1);assert(guides[0].components.some(row=>row.components.some(button=>button.custom_id==='ac:asset-browse:self')))
 assert(!/did:privy:|privy_app_secret_|accessToken|raw_transaction/.test(JSON.stringify(own)))
 report.checks.push('read-only market/transaction boards contain one current blockchain guide and no checked private fields')
 report.nativeProjection={active:property.active,revision:property.revision,world:property.world,worldUUID:property.worldUUID,blockNumber:property.blockNumber,blockHash:property.blockHash,expiresAtMs:property.expiresAtMs,parcels:property.projection.parcels.length}
 report.backups={privateWorldArchiveSha256:backup.archiveSha256,privateDatabaseSha256:backupManifest.databaseBackupSha256};report.status='pass'
}catch(error){report.error=error.code||error.message}finally{await pool?.end()}
const directory=join(root,'evidence/runs/world-assets-host',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,evidence:join(directory,'report.json')}));if(report.status!=='pass')process.exitCode=1
