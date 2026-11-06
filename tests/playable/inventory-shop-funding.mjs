// Isolated PostgreSQL, injected transfer receipts and signer guards. No key opens or network calls.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import pg from '../../backend/node_modules/pg/lib/index.js'
import {createInventoryShopFunding} from '../../backend/src/playable/inventory-shop-funding.mjs'
import {TEST_CITY_GRANT_AMOUNT,TEST_CITY_GRANT_RECIPIENT,TEST_CITY_GRANT_TOKEN,testCityGrantOperationId,validateTestCityGrant,createBankOperatorWallets} from '../../backend/src/bank/operator-wallets.mjs'
const {parseAbi,encodeFunctionData,decodeFunctionData,encodeEventTopics,encodeAbiParameters}=createRequire(new URL('../../backend/package.json',import.meta.url))('viem')
const abi=parseAbi(['function transfer(address to,uint256 value) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)'])
const env=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='test_shop_grant_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:env.databaseUrl,max:1})
const walletSchema='test_shop_grant_wallet_'+randomUUID().replaceAll('-','')
const pool=new pg.Pool({connectionString:env.databaseUrl,max:4,options:'-c search_path='+schema})
const manifest={mode:'marketplace',chainId:1301,city:TEST_CITY_GRANT_TOKEN,serverId:'0x'+'1'.repeat(64),deploymentId:'0x'+'2'.repeat(64),maxNativeCostWei:'500000000000000'}
const principalId=randomUUID(),source='0x'+'3'.repeat(40),hash='0x'+'4'.repeat(64),blockHash='0x'+'5'.repeat(64)
const data=encodeFunctionData({abi,functionName:'transfer',args:[TEST_CITY_GRANT_RECIPIENT,TEST_CITY_GRANT_AMOUNT]})
const request={operationId:testCityGrantOperationId(manifest),to:manifest.city,data,value:0n,limits:{maxGas:100000,maxNativeCostWei:manifest.maxNativeCostWei}}
validateTestCityGrant(manifest,request,decodeFunctionData({abi,data}))
for(const [recipient,amount]of[[source,TEST_CITY_GRANT_AMOUNT],[TEST_CITY_GRANT_RECIPIENT,TEST_CITY_GRANT_AMOUNT-1n]]){
  const changed=encodeFunctionData({abi,functionName:'transfer',args:[recipient,amount]})
  assert.throws(()=>validateTestCityGrant(manifest,{...request,data:changed},decodeFunctionData({abi,data:changed})),/EXACT_TRANSFER_REQUIRED/)
}
assert.throws(()=>validateTestCityGrant(manifest,{...request,operationId:randomUUID()},decodeFunctionData({abi,data})),/EXACT_TRANSFER_REQUIRED/)
assert.throws(()=>testCityGrantOperationId({...manifest,chainId:1}),/CURRENT_MARKETPLACE_REQUIRED/)
console.log('PASS dedicated grant permits only fixed current test CITY, designated recipient, exact 100 CITY and original operation ID')
let created=false,allowed=false,confirmed=false,preflights=0,recipient=TEST_CITY_GRANT_RECIPIENT,subject='did:privy:fixture'
const intents=new Map()
const receipt={status:'success',blockNumber:10n,blockHash,logs:[{address:manifest.city,
  topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:source,to:TEST_CITY_GRANT_RECIPIENT}}),
  data:encodeAbiParameters([{type:'uint256'}],[TEST_CITY_GRANT_AMOUNT])}]}
const signer={address:source,operationId:request.operationId,preflight:async()=>{preflights++},prepare:async input=>{
  validateTestCityGrant(manifest,input,decodeFunctionData({abi,data:input.data}))
  if(intents.has(input.operationId))assert.equal(intents.get(input.operationId).data,input.data);else intents.set(input.operationId,input)
  return{hash,status:'prepared'}
},broadcast:async()=>({hash,status:'unknown'}),reconcile:async()=>confirmed?{hash,status:'confirmed',receipt}:{hash,status:'unknown'}}
try{
  await admin.query('CREATE SCHEMA '+schema);created=true
  const grant=await createInventoryShopFunding({pool,manifest,wallets:{testCityGrant:()=>signer},client:{getTransaction:async()=>({from:source,to:manifest.city,input:data,value:0n}),getBlockNumber:async()=>11n,getBlock:async()=>({hash:blockHash})},
    resolveIdentity:async input=>({principalId:input.principalId,privySubject:subject,walletAddress:recipient,nativeApproved:true,walletSignatureVerified:true}),
    authorize:async authority=>({authorized:allowed,...authority})})
  const preview=await grant.preview({principalId}),consent={principalId,termsDigest:preview.termsDigest,confirmationId:randomUUID()}
  await assert.rejects(grant.confirm(consent),/EXPLICIT_CONFIRMATION_REQUIRED/);assert.equal(intents.size,0)
  allowed=true
  assert.equal((await grant.confirm(consent)).status,'funding');assert.equal(intents.size,1);assert.equal(preflights,1)
  confirmed=true
  assert.equal((await grant.confirm(consent)).status,'complete');assert.equal(intents.size,1);assert.equal(preflights,1)
  assert.equal((await grant.confirm(consent)).status,'complete');assert.equal(intents.size,1)
  console.log('PASS explicit fixture consent retains one original transfer across unknown reply, confirmation and repeated claim without resetting budget or nonce')
  recipient=source
  await assert.rejects(grant.preview({principalId}),/VERIFIED_WALLET_REQUIRED/);recipient=TEST_CITY_GRANT_RECIPIENT
  await assert.rejects(grant.preview({principalId:randomUUID()}),/QUOTA_OR_BINDING_CONFLICT/)
  subject='did:privy:changed'
  await assert.rejects(grant.preview({principalId}),/QUOTA_OR_BINDING_CONFLICT/)
  await assert.rejects(pool.query("UPDATE ac_inventory_shop_city_grants SET state='preview' WHERE grant_id=1"),/CITY_GRANT_IMMUTABLE/)
  await assert.rejects(pool.query('UPDATE ac_inventory_shop_city_grants SET recipient=$1 WHERE grant_id=1',[source]),/CITY_GRANT_IMMUTABLE/)
  console.log('PASS singleton quota and immutable recipient, principal, identity, consent and completed receipt prevent another grant or redirected retry')
  const root=new URL('../..',import.meta.url).pathname
  const actualManifest=JSON.parse(await readFile(new URL('../../.local/marketplace/public-deployment.json',import.meta.url),'utf8'))
  const settings=JSON.parse(await readFile(new URL('../../.local/bank/operator-settings.json',import.meta.url),'utf8'))
  let rpcReads=0
  const operator=await createBankOperatorWallets({rootDirectory:root,pool,manifest:{...actualManifest,journalSchema:walletSchema},settings,
    client:{getChainId:async()=>{rpcReads++;throw Error('No network in operator guard fixture')}}})
  const transfer={operationId:randomUUID(),playerId:settings.actors.seller.principalId,to:TEST_CITY_GRANT_TOKEN,data,value:0n,limits:{maxGas:100000,maxNativeCostWei:actualManifest.maxNativeCostWei}}
  await assert.rejects(operator.prepare(transfer),/BANK_OPERATOR_TOKEN_CALL_DENIED/)
  await assert.rejects(operator.role('registrar').prepare({...transfer,playerId:undefined}),/BANK_OPERATOR_TOKEN_CALL_DENIED/)
  const fixed=operator.testCityGrant()
  const redirected=encodeFunctionData({abi,functionName:'transfer',args:[source,TEST_CITY_GRANT_AMOUNT]})
  await assert.rejects(fixed.prepare({...transfer,playerId:undefined,operationId:fixed.operationId,data:redirected}),/EXACT_TRANSFER_REQUIRED/)
  await assert.rejects(fixed.prepare({...transfer,playerId:undefined,operationId:randomUUID()}),/EXACT_TRANSFER_REQUIRED/)
  assert.equal(rpcReads,0)
  console.log('PASS real operator adapter keeps ordinary transfer forbidden and rejects grant redirection or replacement IDs before RPC/key access')
}finally{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+walletSchema+' CASCADE');if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()}
