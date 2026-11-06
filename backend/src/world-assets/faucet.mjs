import {readFile,lstat} from 'node:fs/promises'
import {join,delimiter} from 'node:path'
import {createHash} from 'node:crypto'
import {createPublicClient,http,keccak256,parseAbi,encodeFunctionData,parseEventLogs,parseTransaction} from 'viem'
import {unichainSepolia} from 'viem/chains'
import {PostgresStore} from '../storage/postgres.mjs'
import {PublicTestnetEvm} from '../chain/public-testnet.mjs'
import {openDevelopmentKeystore} from '../chain/development-wallets.mjs'
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,ADDRESS=/^0x[a-f0-9]{40}$/i
export const WORLD_FAUCET_CITY=100n*10n**18n,WORLD_FAUCET_NATIVE=100000000000000n,WORLD_FAUCET_SEED_NATIVE=2000000000000000n
const abi=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address to,uint256 value) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)'])
const fail=code=>{throw Object.assign(Error(code),{code})}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const faucetOperationId=(value,kind)=>{const h=hash([value,kind]).slice(0,32);return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-')}
let unlockTail=Promise.resolve()
export async function unlockWorldFaucetSigner(rootDirectory,metadata){
 const pending=unlockTail.then(async()=>{const before=process.env.PATH;try{process.env.PATH=join(rootDirectory,'.local/tools/foundry-linux')+delimiter+(before||'');return await openDevelopmentKeystore(metadata)}finally{process.env.PATH=before}})
 unlockTail=pending.catch(()=>{});return pending
}
export async function worldFaucetJournal(pool,schema){
 if(!/^(world_asset_faucet_(?:seed_)?1301|test_world_faucet_[a-f0-9]{32})$/.test(schema))fail('WORLD_FAUCET_JOURNAL_REQUIRED')
 await pool.query('CREATE SCHEMA IF NOT EXISTS '+schema)
 const rewrite=sql=>sql.replace(/\bac_chain_[a-z_]+\b/g,name=>schema+'.'+name),store=Object.create(PostgresStore.prototype)
 store.pool={query:(sql,args)=>pool.query(rewrite(sql),args),connect:async()=>{const tx=await pool.connect();return{query:(sql,args)=>tx.query(rewrite(sql),args),release:()=>tx.release()}}}
 await store.query(await readFile(new URL('../chain/schema.sql',import.meta.url),'utf8'));return store
}

/** Fixed one-time testnet onboarding subsidy; not a reward for Minecraft work. */
export async function createWorldAssetFaucet({rootDirectory,pool,manifest,resolveIdentity,authorize,fixture}={}){
 if(!pool?.connect||!rootDirectory||typeof resolveIdentity!=='function'||typeof authorize!=='function'||manifest?.chainId!==1301||manifest.environment!=='UNICHAIN_SEPOLIA_WORLD_ASSETS'||manifest.rpcUrl!=='https://sepolia.unichain.org')fail('WORLD_FAUCET_CONFIGURATION_REQUIRED')
 if(fixture&&(!fixture.label||!/^test_world_faucet_[a-f0-9]{32}$/.test(fixture.schema||'')||typeof fixture.loadSigner!=='function'||typeof fixture.evmFactory!=='function'))fail('WORLD_FAUCET_DISCLOSED_FIXTURE_REQUIRED')
 const settings=fixture?fixture.settings:JSON.parse(await readFile(join(rootDirectory,'.local/world-assets/faucet-settings.json'),'utf8'))
 const address=String(settings.address||'').toLowerCase()
 if(settings.schema!=='agentcity.world-asset-faucet.v1'||settings.chainId!==1301||settings.city?.toLowerCase()!==manifest.city.toLowerCase()||!ADDRESS.test(address)||
  [manifest.roles.administrator,manifest.roles.registrar,manifest.roles.publisher,manifest.paymentManifest?.issuer].filter(Boolean).some(value=>value.toLowerCase()===address)||
  String(settings.seedNativeWei)!==String(WORLD_FAUCET_SEED_NATIVE)||settings.maxPrincipals!==10)fail('WORLD_FAUCET_DISTINCT_FINITE_ROLE_REQUIRED')
 if(!fixture){if(typeof process.getuid!=='function'||![settings.keystore,settings.passwordFile].every(path=>typeof path==='string'&&path.includes('/role-world-faucet/')))fail('WORLD_FAUCET_PRIVATE_ROLE_REQUIRED');for(const path of[settings.keystore,settings.passwordFile]){const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))fail('WORLD_FAUCET_PRIVATE_ROLE_REQUIRED')}}
 const client=fixture?.client||createPublicClient({chain:unichainSepolia,transport:http(manifest.rpcUrl,{retryCount:0,timeout:15000})})
 const schema=fixture?fixture.schema:'world_asset_faucet_1301',store=await worldFaucetJournal(pool,schema)
 await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.grants(operation_id uuid PRIMARY KEY,principal_id uuid NOT NULL UNIQUE,
  recipient text NOT NULL,wallet_id text NOT NULL,terms_digest text NOT NULL,state text NOT NULL DEFAULT 'preview',
  consent jsonb,city_receipt jsonb,native_receipt jsonb,created_at timestamptz NOT NULL DEFAULT now())`)
 await pool.query(`CREATE OR REPLACE FUNCTION ${schema}.protect_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.operation_id,NEW.principal_id,NEW.recipient,NEW.wallet_id,NEW.terms_digest,NEW.created_at) IS DISTINCT FROM (OLD.operation_id,OLD.principal_id,OLD.recipient,OLD.wallet_id,OLD.terms_digest,OLD.created_at)
 OR (OLD.consent IS NOT NULL AND NEW.consent IS DISTINCT FROM OLD.consent)
 OR (OLD.city_receipt IS NOT NULL AND NEW.city_receipt IS DISTINCT FROM OLD.city_receipt)
 OR (OLD.native_receipt IS NOT NULL AND NEW.native_receipt IS DISTINCT FROM OLD.native_receipt)
 OR (OLD.state='complete' AND NEW.state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'WORLD_FAUCET_GRANT_IMMUTABLE'; END IF; RETURN NEW; END; $$;
 DROP TRIGGER IF EXISTS protect_grant ON ${schema}.grants; CREATE TRIGGER protect_grant BEFORE UPDATE ON ${schema}.grants FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_grant();`)
 async function verify(){if(await client.getChainId()!==1301||(await client.getBlock({blockNumber:0n})).hash.toLowerCase()!==manifest.genesisHash.toLowerCase())fail('WORLD_FAUCET_CHAIN_CHANGED');const code=await client.getCode({address:manifest.city});if(!code||keccak256(code).toLowerCase()!==manifest.codeHashes.city.toLowerCase())fail('WORLD_FAUCET_CITY_CODE_CHANGED')}
 async function owner(principalId){
  if(!UUID.test(principalId||''))fail('WORLD_FAUCET_OWNER_REQUIRED')
  const resolved=await resolveIdentity({principalId}),did=resolved?.privySubject,discord=resolved?.discordUserId
  if((resolved?.principalId||resolved?.ownerId)!==principalId||typeof did!=='string'||typeof discord!=='string')fail('WORLD_FAUCET_VERIFIED_IDENTITY_REQUIRED')
  const row=(await pool.query(`SELECT w.* FROM ac_discord_principals p JOIN ac_discord_identities d USING(principal_id)
   JOIN ac_discord_wallet_aliases a USING(principal_id) JOIN ac_playable_testnet_wallets w USING(wallet_id)
   WHERE p.principal_id=$1 AND p.privy_subject=$2 AND d.discord_user_id=$3 AND a.wallet_id=$4
   AND w.environment='UNICHAIN_SEPOLIA_PLAYABLE' AND w.provider_type='privy' AND lower(a.address)=lower(w.address)
   AND a.provider_account_id=w.provider_account_id`,[principalId,did,discord,'UNICHAIN_SEPOLIA_PLAYABLE:'+principalId])).rows
  if(row.length!==1||row[0].auth_subject_hash!==createHash('sha256').update(did).digest('hex')||resolved.address&&resolved.address.toLowerCase()!==row[0].address.toLowerCase()||resolved.walletAddress&&resolved.walletAddress.toLowerCase()!==row[0].address.toLowerCase()||resolved.walletId&&resolved.walletId!==row[0].wallet_id)fail('WORLD_FAUCET_RECIPIENT_BINDING_REQUIRED')
  return{principalId,discordUserId:discord,recipient:row[0].address.toLowerCase(),walletId:row[0].wallet_id}
 }
 const terms=row=>({recipient:row.recipient,cityAmountBaseUnits:String(WORLD_FAUCET_CITY),nativeAmountWei:String(WORLD_FAUCET_NATIVE),chainId:1301,faucet:address})
 const view=row=>({operationId:row.operation_id,status:row.state==='complete'?'complete':row.state==='preview'?'preview':'pending',termsDigest:row.terms_digest,terms:terms(row),message:row.state==='complete'?'Your one-time testnet onboarding grant is complete.':'One-time testnet onboarding grant: 100 CITY and 0.0001 test ETH. Explicit confirmation is required; this is not a reward for game work.'})
 async function preview({principalId,operationId}){
  if(!UUID.test(operationId||''))fail('WORLD_FAUCET_OPERATION_REQUIRED')
  const identity=await owner(principalId)
  return store.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['world-faucet-owner:'+principalId]);let row=(await tx.query('SELECT * FROM '+schema+'.grants WHERE principal_id=$1 OR operation_id=$2',[principalId,operationId])).rows
   if(row.length){if(row.length!==1||row[0].principal_id!==principalId||row[0].recipient!==identity.recipient||row[0].wallet_id!==identity.walletId)fail('WORLD_FAUCET_IMMUTABLE_RECIPIENT_REQUIRED');return view(row[0])}
   const digest=hash({principalId,operationId,...terms(identity)})
   row=(await tx.query('INSERT INTO '+schema+'.grants(operation_id,principal_id,recipient,wallet_id,terms_digest) VALUES($1,$2,$3,$4,$5) RETURNING *',[operationId,principalId,identity.recipient,identity.walletId,digest])).rows[0];return view(row)
  })
 }
 function engine(){if(fixture)return fixture.evmFactory({store,address,nativeCap:WORLD_FAUCET_SEED_NATIVE});const evm=new PublicTestnetEvm({store,chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,environment:'PUBLIC_TESTNET_WORLD_ASSETS',allowedSigners:[address]});evm.nativeCap=WORLD_FAUCET_SEED_NATIVE;return evm}
 async function confirm({principalId,operationId,termsDigest,confirmationId}){
  const identity=await owner(principalId)
  if(!UUID.test(operationId||'')||typeof confirmationId!=='string'||confirmationId.length<5||confirmationId.length>128)fail('WORLD_FAUCET_OWNER_CONFIRMATION_REQUIRED')
  let row=(await pool.query('SELECT * FROM '+schema+'.grants WHERE principal_id=$1 AND operation_id=$2',[principalId,operationId])).rows[0]
  if(!row||row.terms_digest!==termsDigest||row.recipient!==identity.recipient||row.wallet_id!==identity.walletId)fail('WORLD_FAUCET_IMMUTABLE_RECIPIENT_REQUIRED')
  if(row.state==='complete')return view(row)
  await verify()
  if(!row.consent){
   if(Number((await pool.query('SELECT count(*) FROM '+schema+'.grants WHERE consent IS NOT NULL')).rows[0].count)>=10)fail('WORLD_FAUCET_FINITE_PLAYER_LIMIT')
   const authority=await authorize({action:'world_asset_faucet',principalId,operationId,termsDigest,confirmationId,discordUserId:identity.discordUserId,...terms(row)})
   if(authority?.authorized!==true||authority.principalId!==principalId||authority.operationId!==operationId||authority.termsDigest!==termsDigest||authority.confirmationId!==confirmationId||authority.discordUserId!==identity.discordUserId)fail('WORLD_FAUCET_EXPLICIT_OWNER_CONFIRMATION_REQUIRED')
   if(await client.readContract({address:manifest.city,abi,functionName:'balanceOf',args:[address]})<WORLD_FAUCET_CITY||await client.getBalance({address})<=WORLD_FAUCET_NATIVE)fail('WORLD_FAUCET_OPERATOR_SEED_REQUIRED')
   await store.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['world-faucet-finite-quota']);const locked=(await tx.query('SELECT * FROM '+schema+'.grants WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];if(!locked.consent){const count=Number((await tx.query('SELECT count(*) FROM '+schema+'.grants WHERE consent IS NOT NULL')).rows[0].count);if(count>=10)fail('WORLD_FAUCET_FINITE_PLAYER_LIMIT');await tx.query("UPDATE "+schema+".grants SET consent=$2,state='funding' WHERE operation_id=$1",[operationId,authority])}})
   row=(await pool.query('SELECT * FROM '+schema+'.grants WHERE operation_id=$1',[operationId])).rows[0]
  }
  const evm=engine()
  for(const leg of['city','native']){
   if(row[leg+'_receipt'])continue
   const op=faucetOperationId(operationId,leg),to=leg==='city'?manifest.city:row.recipient,data=leg==='city'?encodeFunctionData({abi,functionName:'transfer',args:[row.recipient,WORLD_FAUCET_CITY]}):'0x',value=leg==='native'?WORLD_FAUCET_NATIVE:0n
   let intent=(await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1',[op])).rows[0]
   if(!intent){const signer=fixture?await fixture.loadSigner():await unlockWorldFaucetSigner(rootDirectory,settings);if(signer.address.toLowerCase()!==address)fail('WORLD_FAUCET_SIGNER_CHANGED');intent=await evm.prepare(op,signer,to,data,value)}
   if(intent.account!==address||intent.destination.toLowerCase()!==to.toLowerCase()||intent.calldata!==data)fail('WORLD_FAUCET_RETAINED_INTENT_CHANGED')
   if(!fixture){const parsed=parseTransaction(intent.raw_transaction);if(parsed.chainId!==1301||BigInt(parsed.value||0)!==value||parsed.to?.toLowerCase()!==to.toLowerCase()||(parsed.data||'0x')!==data||keccak256(intent.raw_transaction)!==intent.transaction_hash)fail('WORLD_FAUCET_RETAINED_INTENT_CHANGED')}
   await evm.broadcast(op)
   const result=await evm.receipt(op,2)
   if(result.status!=='confirmed')return view(row)
   if(!fixture){const transaction=await client.getTransaction({hash:result.hash});if(transaction.from.toLowerCase()!==address||transaction.to.toLowerCase()!==to.toLowerCase()||transaction.input!==data||transaction.value!==value)fail('WORLD_FAUCET_CANONICAL_TRANSFER_CHANGED');if(leg==='city'){const logs=parseEventLogs({abi,eventName:'Transfer',logs:result.receipt.logs,strict:true}).filter(log=>log.address.toLowerCase()===manifest.city.toLowerCase()&&log.args.from.toLowerCase()===address&&log.args.to.toLowerCase()===row.recipient&&log.args.value===WORLD_FAUCET_CITY);if(logs.length!==1)fail('WORLD_FAUCET_EXACT_CITY_RECEIPT_REQUIRED')}}
   const proof={transactionHash:result.hash,status:'confirmed',amount:leg==='city'?String(WORLD_FAUCET_CITY):String(WORLD_FAUCET_NATIVE)}
   await pool.query('UPDATE '+schema+'.grants SET '+leg+'_receipt=$2 WHERE operation_id=$1 AND '+leg+'_receipt IS NULL',[operationId,proof]);row[leg+'_receipt']=proof
  }
  row=(await pool.query("UPDATE "+schema+".grants SET state='complete' WHERE operation_id=$1 AND city_receipt IS NOT NULL AND native_receipt IS NOT NULL RETURNING *",[operationId])).rows[0]
  return view(row)
 }
 return{address,preview,confirm,close:async()=>{}}
}
