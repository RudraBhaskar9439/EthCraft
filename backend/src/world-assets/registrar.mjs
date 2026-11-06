import {readFile,lstat} from 'node:fs/promises'
import {join,delimiter} from 'node:path'
import {createPublicClient,http,decodeFunctionData,keccak256,stringToHex,parseAbi,zeroAddress} from 'viem'
import {unichainSepolia} from 'viem/chains'
import {PostgresStore} from '../storage/postgres.mjs'
import {PublicTestnetEvm,TESTNET_NATIVE_CAP} from '../chain/public-testnet.mjs'
import {openDevelopmentKeystore} from '../chain/development-wallets.mjs'
import {registryAbi} from './abis.mjs'
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,ADDRESS=/^0x[a-f0-9]{40}$/i,HASH=/^0x[a-f0-9]{64}$/i
const roleAbi=parseAbi(['function hasRole(bytes32 role,address account) view returns(bool)'])
const role=keccak256(stringToHex('REGISTRAR_ROLE')),adminRole='0x'+'0'.repeat(64)
const fail=code=>{throw Object.assign(Error(code),{code})}
let unlockTail=Promise.resolve()

/** Encrypted development registrar only; never a player-wallet provider. */
export async function createWorldAssetRegistrar({rootDirectory,pool,manifest,client,fixture}={}){
 if(!pool?.connect||!rootDirectory||manifest?.schema!=='agentcity.world-assets.v1'||manifest.environment!=='UNICHAIN_SEPOLIA_WORLD_ASSETS'||manifest.chainId!==1301||manifest.rpcUrl!=='https://sepolia.unichain.org'||
  !HASH.test(manifest.genesisHash||'')||!ADDRESS.test(manifest.registry||'')||!HASH.test(manifest.codeHashes?.registry||'')||!ADDRESS.test(manifest.roles?.registrar||'')||!ADDRESS.test(manifest.roles?.administrator||'')||
  manifest.roles.registrar.toLowerCase()===manifest.roles.administrator.toLowerCase()||BigInt(manifest.maxNativeCostWei||0)>TESTNET_NATIVE_CAP)fail('WORLD_REGISTRAR_PINNED_PUBLIC_MANIFEST_REQUIRED')
 if(fixture&&(!fixture.label||!/^test_world_registrar_[a-f0-9]{32}$/.test(fixture.journalSchema||'')||typeof fixture.evmFactory!=='function'||typeof fixture.loadSigner!=='function'))fail('WORLD_REGISTRAR_DISCLOSED_FIXTURE_REQUIRED')
 const metadata=fixture?{address:fixture.address}:JSON.parse(await readFile(join(rootDirectory,'.local/world-assets/registrar-settings.json'),'utf8'))
 const address=String(metadata.address||'').toLowerCase()
 if(!ADDRESS.test(address)||address!==manifest.roles.registrar.toLowerCase()||address===manifest.roles.administrator.toLowerCase()||address===manifest.paymentManifest?.issuer?.toLowerCase())fail('WORLD_REGISTRAR_DISTINCT_ROLE_KEY_REQUIRED')
 if(!fixture){
  if(typeof process.getuid!=='function'||![metadata.keystore,metadata.passwordFile].every(path=>typeof path==='string'&&path.includes('/role-world-registrar/')))fail('WORLD_REGISTRAR_PRIVATE_ROLE_KEY_REQUIRED')
  for(const path of[metadata.keystore,metadata.passwordFile]){const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))fail('WORLD_REGISTRAR_PRIVATE_ROLE_KEY_REQUIRED')}
 }
 client??=createPublicClient({chain:unichainSepolia,transport:http(manifest.rpcUrl,{retryCount:0,timeout:15000})})
 async function verify(){
  if(await client.getChainId()!==1301||(await client.getBlock({blockNumber:0n})).hash.toLowerCase()!==manifest.genesisHash.toLowerCase())fail('WORLD_REGISTRAR_CHAIN_INSTANCE_CHANGED')
  const code=await client.getCode({address:manifest.registry})
  if(!code||code==='0x'||keccak256(code).toLowerCase()!==manifest.codeHashes.registry.toLowerCase())fail('WORLD_REGISTRAR_REGISTRY_CODE_CHANGED')
  const [registrar,administrator]=await Promise.all([role,adminRole].map(role=>client.readContract({address:manifest.registry,abi:roleAbi,functionName:'hasRole',args:[role,address]})))
  if(registrar!==true||administrator!==false)fail('WORLD_REGISTRAR_ROLE_CHANGED')
 }
 await verify()
 const schema=fixture?fixture.journalSchema:'world_asset_operations_1301'
 await pool.query('CREATE SCHEMA IF NOT EXISTS '+schema)
 const rewrite=sql=>sql.replace(/\bac_chain_[a-z_]+\b/g,name=>schema+'.'+name)
 const wrap=connection=>({query:(sql,args)=>connection.query(rewrite(sql),args),release:()=>connection.release()})
 const store=Object.create(PostgresStore.prototype)
 store.pool={query:(sql,args)=>pool.query(rewrite(sql),args),connect:async()=>wrap(await pool.connect())}
 await store.query(await readFile(new URL('../chain/schema.sql',import.meta.url),'utf8'))
 await pool.query('CREATE TABLE IF NOT EXISTS '+schema+'.registrar_bindings(operation_id uuid PRIMARY KEY,binding jsonb NOT NULL)')
 const allowed=new Set(['mintItem','mintParcel','updateParcelSnapshot','finalizeRedemption'])
 function validate(input){
  if(!UUID.test(input.operationId||'')||!ADDRESS.test(input.to||'')||input.to.toLowerCase()!==manifest.registry.toLowerCase()||BigInt(input.value??0)!==0n||!/^0x[0-9a-f]+$/i.test(input.data||''))fail('WORLD_REGISTRAR_EXACT_REGISTRY_CALL_REQUIRED')
  let decoded
  try{decoded=decodeFunctionData({abi:registryAbi,data:input.data})}catch{fail('WORLD_REGISTRAR_ABI_CALL_REQUIRED')}
  if(!allowed.has(decoded.functionName))fail('WORLD_REGISTRAR_SELECTOR_DENIED')
  if(decoded.functionName.startsWith('mint')&&(decoded.args[0].toLowerCase()===zeroAddress||decoded.args[1].toLowerCase()!==manifest.serverId.toLowerCase()))fail('WORLD_REGISTRAR_NATIVE_SERVER_BINDING_REQUIRED')
  const limits=input.limits||{},maxGas=BigInt(limits.maxGas??0),maxCost=BigInt(limits.maxNativeCostWei??0)
  if(maxGas<21000n||maxGas>BigInt(manifest.maxGas)||maxCost<=0n||maxCost>BigInt(manifest.maxNativeCostWei))fail('WORLD_REGISTRAR_CALL_LIMIT_REQUIRED')
  return{to:input.to.toLowerCase(),data:input.data.toLowerCase(),value:'0',limits:{maxGas:String(maxGas),maxNativeCostWei:String(maxCost)}}
 }
 function evm(limits){
  if(fixture)return fixture.evmFactory({store,client,address,limits,nativeCap:TESTNET_NATIVE_CAP})
  const engine=new PublicTestnetEvm({store,chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,environment:'PUBLIC_TESTNET_WORLD_ASSETS',allowedSigners:[address]})
  const base=engine.validateRequest.bind(engine)
  engine.validateRequest=async(tx,request)=>{
   if(request.gas>BigInt(limits.maxGas)||request.gas*BigInt(request.maxFeePerGas??request.gasPrice)>BigInt(limits.maxNativeCostWei)||BigInt(request.value||0)!==0n)fail('WORLD_REGISTRAR_CALL_LIMIT_EXCEEDED')
   await base(tx,request)
  }
  return engine
 }
 const defaults={maxGas:manifest.maxGas,maxNativeCostWei:manifest.maxNativeCostWei}
 async function bound(operationId){if(!UUID.test(operationId||''))fail('WORLD_REGISTRAR_OPERATION_REQUIRED');const row=(await pool.query('SELECT * FROM '+schema+'.registrar_bindings WHERE operation_id=$1',[operationId])).rows[0];if(!row)fail('WORLD_REGISTRAR_RETAINED_INTENT_REQUIRED');validate({operationId,...row.binding});return row.binding}
 return{address,
  async prepare(input){
   const binding=validate(input);await verify()
   await store.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['world-registrar:'+input.operationId]);await tx.query('INSERT INTO '+schema+'.registrar_bindings(operation_id,binding) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.operationId,binding]);const old=(await tx.query('SELECT binding FROM '+schema+'.registrar_bindings WHERE operation_id=$1',[input.operationId])).rows[0].binding;
    if(old.to!==binding.to||old.data!==binding.data||old.value!==binding.value||old.limits.maxGas!==binding.limits.maxGas||old.limits.maxNativeCostWei!==binding.limits.maxNativeCostWei)fail('WORLD_REGISTRAR_OPERATION_IMMUTABLE')})
   const engine=evm(binding.limits)
   const existing=(await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1',[input.operationId])).rows[0]
   if(existing){if(existing.account!==address||existing.destination!==binding.to||existing.calldata!==binding.data||existing.chain_instance!=='1301:'+manifest.genesisHash)fail('WORLD_REGISTRAR_RETAINED_INTENT_BINDING_CHANGED');return{operationId:input.operationId,hash:existing.transaction_hash,transactionHash:existing.transaction_hash,status:existing.status}}
   let signer
   if(fixture)signer=await fixture.loadSigner()
   else{const unlock=unlockTail.then(async()=>{const oldPath=process.env.PATH;try{process.env.PATH=join(rootDirectory,'.local/tools/foundry-linux')+delimiter+(oldPath||'');return await openDevelopmentKeystore(metadata)}finally{process.env.PATH=oldPath}});unlockTail=unlock.catch(()=>{});signer=await unlock}
   if(signer.address.toLowerCase()!==address)fail('WORLD_REGISTRAR_SIGNER_CHANGED')
   const intent=await engine.prepare(input.operationId,signer,binding.to,binding.data,0n)
   return{operationId:input.operationId,hash:intent.transaction_hash,transactionHash:intent.transaction_hash,status:intent.status}
  },
  async broadcast({operationId}){await bound(operationId);await verify();const result=await evm(defaults).broadcast(operationId);return{...result,transactionHash:result.hash}},
  async reconcile({operationId}){await bound(operationId);await verify();const result=await evm(defaults).receipt(operationId,2);return{status:result.status,hash:result.hash,transactionHash:result.hash,receipt:result.receipt}},
  verify,close:async()=>{}}
}
