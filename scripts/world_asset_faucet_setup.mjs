// --seed is an explicit operator action. Default creates a NEW empty role only.
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {randomUUID,createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {ensureTestnetKeystore} from '../backend/src/playable/testnet-wallets.mjs'
import {PublicTestnetEvm} from '../backend/src/chain/public-testnet.mjs'
import {worldFaucetJournal,unlockWorldFaucetSigner,faucetOperationId,WORLD_FAUCET_SEED_NATIVE} from '../backend/src/world-assets/faucet.mjs'
const require=createRequire(new URL('../backend/package.json',import.meta.url)),{Pool}=require('pg'),{createPublicClient,http,keccak256,parseAbi,encodeFunctionData}=require('viem'),{unichainSepolia}=require('viem/chains')
const {acquireLocalLease,writeCheckpoint}=require('./src/bot/checkpoint-store.cjs')
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'.local/world-assets'),args=process.argv.slice(2)
if(process.platform==='win32'||args.length>1||args.length===1&&args[0]!=='--seed')throw Error('RUN_IN_WSL_DEFAULT_EMPTY_ROLE_OR_EXPLICIT_SEED')
const release=await acquireLocalLease('agentcity-world-faucet-setup'),read=async path=>JSON.parse(await readFile(path,'utf8'))
let pool,reportPath
const report={status:'fail',scope:'Finite dedicated faucet role setup; seeding only with explicit --seed',publicTransactions:0,playerTransfers:0}
try{
 const manifest=await read(join(dir,'asset-market.json')),developer=await read(join(root,'.local/playable-testnet/account-settings.json'))
 if(manifest.chainId!==1301||manifest.rpcUrl!=='https://sepolia.unichain.org'||manifest.environment!=='UNICHAIN_SEPOLIA_WORLD_ASSETS')throw Error('PINNED_WORLD_ASSET_TESTNET_REQUIRED')
 if(developer.address.toLowerCase()!==manifest.roles.administrator.toLowerCase()||!String(developer.keystore).includes('/role-developer/'))throw Error('APPROVED_EXISTING_DEVELOPER_SEED_ROLE_REQUIRED')
 const path=join(dir,'faucet-settings.json');let settings
 try{settings=await read(path)}catch(error){if(error.code!=='ENOENT')throw error}
 const metadata=await ensureTestnetKeystore({rootDirectory:root,privateRoot:settings?.privateRoot||developer.privateRoot,keyId:'role-world-faucet'})
 if(settings&&settings.address.toLowerCase()!==metadata.address.toLowerCase())throw Error('FAUCET_ROLE_CHANGED')
 if([manifest.roles.administrator,manifest.roles.registrar,manifest.roles.publisher,manifest.paymentManifest.issuer].some(address=>address.toLowerCase()===metadata.address.toLowerCase()))throw Error('DISTINCT_FAUCET_ROLE_REQUIRED')
 settings={schema:'agentcity.world-asset-faucet.v1',chainId:1301,city:manifest.city,...metadata,seedCityBaseUnits:String(1000n*10n**18n),seedNativeWei:String(WORLD_FAUCET_SEED_NATIVE),maxPrincipals:10}
 await mkdir(dir,{recursive:true});await writeCheckpoint(path,settings)
 const planPath=join(dir,'faucet-seed-plan.json');let plan
 try{plan=await read(planPath)}catch(error){if(error.code!=='ENOENT')throw error;plan={runId:randomUUID(),operationId:randomUUID(),recipient:metadata.address.toLowerCase(),developer:developer.address.toLowerCase(),city:manifest.city,cityAmountBaseUnits:settings.seedCityBaseUnits,nativeAmountWei:settings.seedNativeWei};await writeCheckpoint(planPath,plan)}
 if(plan.recipient!==metadata.address.toLowerCase()||plan.developer!==developer.address.toLowerCase()||plan.city.toLowerCase()!==manifest.city.toLowerCase()||plan.cityAmountBaseUnits!==settings.seedCityBaseUnits||plan.nativeAmountWei!==settings.seedNativeWei)throw Error('FAUCET_SEED_TERMS_CHANGED')
 const client=createPublicClient({chain:unichainSepolia,transport:http(manifest.rpcUrl,{retryCount:0,timeout:15000})})
 if(await client.getChainId()!==1301||(await client.getBlock({blockNumber:0n})).hash!==manifest.genesisHash||keccak256(await client.getCode({address:manifest.city}))!==manifest.codeHashes.city)throw Error('FAUCET_PUBLIC_PREFLIGHT_CHANGED')
 if(!args.length){console.log(JSON.stringify({status:'ready_unfunded',address:settings.address,seedCityBaseUnits:settings.seedCityBaseUnits,seedNativeWei:settings.seedNativeWei,maxPrincipals:10,publicTransactions:0,operatorReviewRequiredBeforeSeed:true}));}
 else{
  const evidence=join(root,'evidence/runs/world-assets-faucet-seed',plan.runId);await mkdir(evidence,{recursive:true});reportPath=join(evidence,randomUUID()+'.json')
  const database=await read(join(root,'.local/backend/environment.json'));pool=new Pool({connectionString:database.databaseUrl,max:3})
  const store=await worldFaucetJournal(pool,'world_asset_faucet_seed_1301'),evm=new PublicTestnetEvm({store,chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,environment:'PUBLIC_TESTNET_WORLD_ASSETS',allowedSigners:[developer.address]})
  const abi=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address to,uint256 value) returns(bool)'])
  const receipts={}
  for(const leg of['city','native']){
   const operationId=faucetOperationId(plan.operationId,leg),to=leg==='city'?manifest.city:plan.recipient,data=leg==='city'?encodeFunctionData({abi,functionName:'transfer',args:[plan.recipient,BigInt(plan.cityAmountBaseUnits)]}):'0x',value=leg==='native'?BigInt(plan.nativeAmountWei):0n
   let intent=(await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1',[operationId])).rows[0]
   if(!intent){if(leg==='city'&&await client.readContract({address:manifest.city,abi,functionName:'balanceOf',args:[developer.address]})<BigInt(plan.cityAmountBaseUnits))throw Error('EXISTING_DEVELOPER_CITY_INSUFFICIENT');const signer=await unlockWorldFaucetSigner(root,developer);intent=await evm.prepare(operationId,signer,to,data,value)}
   if(intent.destination.toLowerCase()!==to.toLowerCase()||intent.calldata!==data)throw Error('FAUCET_SEED_RETAINED_INTENT_CHANGED')
   await evm.broadcast(operationId);const result=await evm.receipt(operationId,2);if(result.status!=='confirmed')throw Error('FAUCET_SEED_PENDING_RETRY_SAME_OPERATION')
   receipts[leg]={transactionHash:result.hash,blockHash:result.receipt.blockHash,blockNumber:String(result.receipt.blockNumber)}
  }
  Object.assign(report,{status:'pass',faucet:plan.recipient,seedCityBaseUnits:plan.cityAmountBaseUnits,seedNativeWei:plan.nativeAmountWei,receipts,publicTransactions:2,playerTransfers:0,maxPrincipals:10,sourceSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')});await writeCheckpoint(reportPath,report)
  console.log(JSON.stringify({status:'pass',faucet:plan.recipient,receipts,evidence:reportPath,playerTransfers:0}))
 }
}catch(error){report.error=String(error.shortMessage||error.message).split('\n')[0].slice(0,200);if(reportPath)await writeCheckpoint(reportPath,report);console.log(JSON.stringify({status:'fail',error:report.error,originalSeedOperationsRetained:true,evidence:reportPath}));process.exitCode=1}
finally{if(pool)await pool.end();await release()}
