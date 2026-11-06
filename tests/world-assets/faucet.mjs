// Isolated actual PG with injected finite-chain effects; no real funds/providers.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createWorldAssetFaucet,WORLD_FAUCET_CITY,WORLD_FAUCET_NATIVE,WORLD_FAUCET_SEED_NATIVE} from '../../backend/src/world-assets/faucet.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg'),{keccak256,decodeFunctionData,parseAbi}=require('viem')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json'))),pool=new Pool({connectionString:db.databaseUrl,max:4}),schema='test_world_faucet_'+randomUUID().replaceAll('-','')
const report={status:'fail',scope:'Finite-grant injected EVM and actual isolated PG fixtures; no real wallet key, provider, token or native transfers',checks:[],realPublicTransactions:0}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const faucetAddress='0x0000000000000000000000000000000000001111',city='0x0000000000000000000000000000000000002222',genesis='0x'+'1'.repeat(64)
const manifest={chainId:1301,environment:'UNICHAIN_SEPOLIA_WORLD_ASSETS',rpcUrl:'https://sepolia.unichain.org',genesisHash:genesis,city,codeHashes:{city:keccak256('0x6000')},roles:{administrator:'0x0000000000000000000000000000000000003333',registrar:'0x0000000000000000000000000000000000004444',publisher:'0x0000000000000000000000000000000000005555'}}
const identities=new Map(),balances=new Map(),sent=new Set();let consentCalls=0,signs=0,loseReply=true,bareAuthority=false,tokenStock=1000n*10n**18n,nativeStock=WORLD_FAUCET_SEED_NATIVE
const fixture={label:'disclosed finite faucet fixture',schema,settings:{schema:'agentcity.world-asset-faucet.v1',chainId:1301,city,address:faucetAddress,seedNativeWei:String(WORLD_FAUCET_SEED_NATIVE),maxPrincipals:10},
 client:{getChainId:async()=>1301,getBlock:async()=>({hash:genesis}),getCode:async()=>'0x6000',readContract:async()=>tokenStock,getBalance:async()=>nativeStock},
 loadSigner:async()=>{signs++;return{address:faucetAddress}},evmFactory:({store,nativeCap})=>{
  assert.equal(nativeCap,WORLD_FAUCET_SEED_NATIVE)
  return{prepare:async(op,signer,to,data,value)=>{const txHash=keccak256('0x'+op.replaceAll('-',''));return(await store.query("INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash) VALUES($1,$2,$3,$4,$5,0,'0x00',$6) RETURNING *",[op,'1301:'+genesis,signer.address,to,data,txHash])).rows[0]},
   broadcast:async op=>{if(!sent.has(op)){const row=(await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1',[op])).rows[0];if(row.destination===city){const decoded=decodeFunctionData({abi:parseAbi(['function transfer(address to,uint256 value) returns(bool)']),data:row.calldata});tokenStock-=decoded.args[1];const old=balances.get(decoded.args[0].toLowerCase())||{city:0n,native:0n};old.city+=decoded.args[1];balances.set(decoded.args[0].toLowerCase(),old)}else{nativeStock-=WORLD_FAUCET_NATIVE;const old=balances.get(row.destination)||{city:0n,native:0n};old.native+=WORLD_FAUCET_NATIVE;balances.set(row.destination,old)}sent.add(op)}if(loseReply){loseReply=false;throw Error('fixture lost reply after exact token transfer')}},
   receipt:async op=>({status:'confirmed',hash:(await store.query('SELECT transaction_hash FROM ac_chain_intents WHERE operation_id=$1',[op])).rows[0].transaction_hash,receipt:{fixture:true}})}
 }}
let created=false
try{
 await pool.query('CREATE SCHEMA '+schema);created=true
 // Source identity tables live in the test schema, never public application rows.
 const sourcePool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema,max:4})
 await sourcePool.query(`CREATE TABLE ac_discord_principals(principal_id uuid,privy_subject text);CREATE TABLE ac_discord_identities(principal_id uuid,discord_user_id text);
 CREATE TABLE ac_discord_wallet_aliases(principal_id uuid,wallet_id text,address text,provider_account_id text);
 CREATE TABLE ac_playable_testnet_wallets(wallet_id text,environment text,provider_type text,address text,provider_account_id text,auth_subject_hash text)`)
 const add=async index=>{const principalId=randomUUID(),privySubject='did:privy:fixture'+index,discordUserId=String(100000000000000000n+BigInt(index)),address='0x'+BigInt(10000+index).toString(16).padStart(40,'0'),walletId='UNICHAIN_SEPOLIA_PLAYABLE:'+principalId;const identity={principalId,privySubject,discordUserId,address,walletId};identities.set(principalId,identity);await sourcePool.query('INSERT INTO ac_discord_principals VALUES($1,$2)',[principalId,privySubject]);await sourcePool.query('INSERT INTO ac_discord_identities VALUES($1,$2)',[principalId,discordUserId]);await sourcePool.query('INSERT INTO ac_discord_wallet_aliases VALUES($1,$2,$3,$4)',[principalId,walletId,address,'fixture-'+index]);await sourcePool.query("INSERT INTO ac_playable_testnet_wallets VALUES($1,'UNICHAIN_SEPOLIA_PLAYABLE','privy',$2,$3,$4)",[walletId,address,'fixture-'+index,createHash('sha256').update(privySubject).digest('hex')]);return identity}
 const owner=await add(1)
 const faucet=await createWorldAssetFaucet({rootDirectory:root,pool:sourcePool,manifest,resolveIdentity:async({principalId})=>identities.get(principalId),authorize:async input=>{consentCalls++;return bareAuthority?true:{authorized:true,...input}},fixture})
 const preview=await faucet.preview({principalId:owner.principalId,operationId:randomUUID()})
 assert.equal(signs,0);assert.equal(preview.terms.cityAmountBaseUnits,String(WORLD_FAUCET_CITY));assert.equal(preview.terms.nativeAmountWei,String(WORLD_FAUCET_NATIVE))
 const confirm={principalId:owner.principalId,operationId:preview.operationId,termsDigest:preview.termsDigest,confirmationId:'fixture-actual-owner-interaction'}
 bareAuthority=true;await assert.rejects(faucet.confirm(confirm),/EXPLICIT_OWNER_CONFIRMATION_REQUIRED/);assert.equal(signs,0);bareAuthority=false
 await assert.rejects(faucet.confirm(confirm),/fixture lost reply/)
 const authorityAfterFirst=consentCalls
 const complete=await faucet.confirm(confirm);assert.equal(complete.status,'complete');assert.equal(consentCalls,authorityAfterFirst)
 assert.equal(signs,2);assert.equal(sent.size,2);assert.deepEqual(balances.get(owner.address),{city:WORLD_FAUCET_CITY,native:WORLD_FAUCET_NATIVE})
 assert.deepEqual(await faucet.confirm(confirm),complete);assert.equal(sent.size,2)
 assert.deepEqual(await faucet.preview({principalId:owner.principalId,operationId:randomUUID()}),complete)
 pass('fixed grant waits for structured owner confirmation then reconciles lost reply using original two intents with one grant and no repeat authorization or transfer')
 const other=await add(2)
 await assert.rejects(faucet.confirm({...confirm,principalId:other.principalId}),/IMMUTABLE_RECIPIENT_REQUIRED/)
 identities.set(other.principalId,{...other,address:owner.address})
 await assert.rejects(faucet.preview({principalId:other.principalId,operationId:randomUUID()}),/RECIPIENT_BINDING_REQUIRED/)
 identities.set(other.principalId,other)
 await assert.rejects(sourcePool.query('UPDATE '+schema+'.grants SET recipient=$2 WHERE operation_id=$1',[preview.operationId,other.address]),/WORLD_FAUCET_GRANT_IMMUTABLE/)
 pass('canonical Discord Privy wallet and subject hash bind exact recipient; foreign owner forged address and changed durable grant are refused')
 for(let index=2;index<=10;index++){const identity=index===2?other:await add(index),quote=await faucet.preview({principalId:identity.principalId,operationId:randomUUID()});assert.equal((await faucet.confirm({principalId:identity.principalId,operationId:quote.operationId,termsDigest:quote.termsDigest,confirmationId:'fixture-confirm-'+index})).status,'complete')}
 const eleventh=await add(11),extra=await faucet.preview({principalId:eleventh.principalId,operationId:randomUUID()})
 await assert.rejects(faucet.confirm({principalId:eleventh.principalId,operationId:extra.operationId,termsDigest:extra.termsDigest,confirmationId:'fixture-eleventh'}),/FINITE_PLAYER_LIMIT/)
 assert.equal(tokenStock,0n);assert.equal(nativeStock,WORLD_FAUCET_SEED_NATIVE-10n*WORLD_FAUCET_NATIVE);assert.equal(sent.size,20)
 pass('ten canonical owners exhaust exactly 1000 existing CITY and bounded test ETH; eleventh grant refused without topping up or minting')
 await sourcePool.end();report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{if(created)await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();report.sources={};for(const file of ['backend/src/world-assets/faucet.mjs','scripts/world_asset_faucet_setup.mjs'])report.sources[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');const directory=join(root,'evidence/runs/world-assets-faucet',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
