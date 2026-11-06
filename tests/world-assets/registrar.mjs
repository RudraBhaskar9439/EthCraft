// Disclosed injected EVM/signer + actual isolated PostgreSQL journal fixtures.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createWorldAssetRegistrar} from '../../backend/src/world-assets/registrar.mjs'
import {registryAbi} from '../../backend/src/world-assets/abis.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg'),{keccak256,encodeFunctionData}=require('viem')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json'))),pool=new Pool({connectionString:db.databaseUrl,max:4})
const schema='test_world_registrar_'+randomUUID().replaceAll('-',''),address='0x0000000000000000000000000000000000000022',registry='0x0000000000000000000000000000000000000033',server='0x'+'1'.repeat(64),genesis='0x'+'2'.repeat(64)
const manifest={schema:'agentcity.world-assets.v1',environment:'UNICHAIN_SEPOLIA_WORLD_ASSETS',chainId:1301,rpcUrl:'https://sepolia.unichain.org',genesisHash:genesis,serverId:server,registry,codeHashes:{registry:keccak256('0x6000')},roles:{registrar:address,administrator:'0x0000000000000000000000000000000000000044'},maxGas:'1000000',maxNativeCostWei:'2000000000000000'}
const report={status:'fail',scope:'Injected signer/EVM and isolated actual PG fixtures only; no real key unlock, public transaction or native mint',checks:[],publicTransactions:0,realSignatures:0}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let roleValid=true,unlocks=0,prepares=0,broadcasts=0
const client={getChainId:async()=>1301,getBlock:async()=>({hash:genesis}),getCode:async()=>'0x6000',readContract:async({args})=>args[0]==='0x'+'0'.repeat(64)?false:roleValid}
const fixture={label:'disclosed registrar authorization fixture',journalSchema:schema,address,loadSigner:async()=>{unlocks++;return{address}},evmFactory:({store,nativeCap})=>{
 assert.equal(nativeCap,8000000000000000n)
 return{prepare:async(operationId,account,to,data)=>{
  assert.equal((await store.query('SELECT count(*) FROM '+schema+'.registrar_bindings WHERE operation_id=$1',[operationId])).rows[0].count,'1')
  prepares++;const hash=keccak256(data)
  return(await store.query(`INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash)
   VALUES($1,$2,$3,$4,$5,$6,'0x00',$7) RETURNING *`,[operationId,'1301:'+genesis,account.address,to,data,prepares-1,hash])).rows[0]
 },broadcast:async id=>{broadcasts++;return{status:'submitted',hash:(await store.query('SELECT transaction_hash FROM ac_chain_intents WHERE operation_id=$1',[id])).rows[0].transaction_hash}},receipt:async id=>({status:'confirmed',hash:(await store.query('SELECT transaction_hash FROM ac_chain_intents WHERE operation_id=$1',[id])).rows[0].transaction_hash,receipt:{fixture:true}})}
}}
try{
 const registrar=await createWorldAssetRegistrar({rootDirectory:root,pool,manifest,client,fixture})
 assert.equal(registrar.address,address);assert.equal(unlocks,0);assert.equal(broadcasts,0)
 const data=encodeFunctionData({abi:registryAbi,functionName:'mintItem',args:['0x0000000000000000000000000000000000000055',server,genesis,'0x'+'3'.repeat(64),'0x'+'4'.repeat(64),'0x'+'5'.repeat(64)]})
 const input={operationId:randomUUID(),to:registry,data,value:0n,limits:{maxGas:500000,maxNativeCostWei:'1000000000000000'}}
 const prepared=await registrar.prepare(input)
 assert.deepEqual(await registrar.prepare(input),prepared);assert.equal(prepares,1);assert.equal(unlocks,1);assert.equal(broadcasts,0)
 assert.equal((await registrar.reconcile({operationId:input.operationId})).hash,prepared.hash);assert.equal(broadcasts,0)
 pass('constructor and prepare never broadcast; exact operation binding precedes injected signing and retained intent retries reuse original hash')
 await assert.rejects(registrar.prepare({...input,data:encodeFunctionData({abi:registryAbi,functionName:'updateParcelSnapshot',args:[1n,1n,server,genesis]})}),/OPERATION_IMMUTABLE/)
 await assert.rejects(registrar.prepare({...input,operationId:randomUUID(),to:address}),/EXACT_REGISTRY_CALL_REQUIRED/)
 await assert.rejects(registrar.prepare({...input,operationId:randomUUID(),value:1n}),/EXACT_REGISTRY_CALL_REQUIRED/)
 await assert.rejects(registrar.prepare({...input,operationId:randomUUID(),data:encodeFunctionData({abi:registryAbi,functionName:'approve',args:[address,1n]})}),/SELECTOR_DENIED/)
 await assert.rejects(registrar.prepare({...input,operationId:randomUUID(),limits:{maxGas:1000001,maxNativeCostWei:'1000000000000000'}}),/CALL_LIMIT_REQUIRED/)
 await assert.rejects(createWorldAssetRegistrar({rootDirectory:root,pool,manifest:{...manifest,chainId:1},client,fixture}),/PINNED_PUBLIC_MANIFEST_REQUIRED/)
 assert.equal(unlocks,1);assert.equal(broadcasts,0)
 pass('wrong registry value administrative or transfer selectors mainnet changed payload and raised call limits refuse before signer or send')
 roleValid=false
 await assert.rejects(registrar.prepare({...input,operationId:randomUUID()}),/ROLE_CHANGED/)
 assert.equal(unlocks,1);roleValid=true
 await assert.rejects(registrar.broadcast({operationId:randomUUID()}),/RETAINED_INTENT_REQUIRED/)
 assert.equal((await registrar.broadcast({operationId:input.operationId})).transactionHash,prepared.hash);assert.equal(broadcasts,1)
 assert.equal((await pool.query('SELECT count(*) FROM '+schema+'.ac_chain_intents')).rows[0].count,'1')
 assert.equal((await pool.query("SELECT to_regclass('ac_world_asset_listings') AS name")).rows[0].name,null)
 pass('actual role preflight gates each operation; explicit broadcast requires retained intent and all fixture writes stay in isolated registrar namespace')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();report.sources={};for(const file of ['backend/src/world-assets/registrar.mjs','backend/src/chain/public-testnet.mjs'])report.sources[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');const directory=join(root,'evidence/runs/world-assets-registrar',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}
