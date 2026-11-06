// Explicit faucet-funded testnet extension. Stable intents survive every retry.
import assert from 'node:assert/strict'
import {readFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {PostgresStore} from '../backend/src/storage/postgres.mjs'
import {PublicTestnetEvm} from '../backend/src/chain/public-testnet.mjs'
import {openDevelopmentKeystore} from '../backend/src/chain/development-wallets.mjs'
import {ensureTestnetKeystore} from '../backend/src/playable/testnet-wallets.mjs'
import {MARKET_ABIS,validateMarketManifest} from '../backend/src/playable/uniswap-market.mjs'
const require=createRequire(new URL('../backend/package.json',import.meta.url))
const {createPublicClient,http,encodeDeployData,encodeFunctionData,encodeAbiParameters,parseAbiParameters,parseAbi,keccak256,toHex,getCreate2Address,stringToHex}=require('viem')
const {acquireLocalLease,writeCheckpoint}=require('./src/bot/checkpoint-store.cjs')
const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'.local/world-assets'),execute=process.argv.length===3&&process.argv[2]==='--deploy'
if(process.argv.length>2&&!execute)throw Error('Use no arguments for read-only preflight or --deploy for faucet-funded deployment')
if(process.platform==='win32')throw Error('World asset signing requires existing private WSL keystores')
const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
const client=createPublicClient({transport:http('https://sepolia.unichain.org',{timeout:15000,retryCount:0})}),base=validateMarketManifest(await json(join(root,'.local/playable-testnet/market.json')))
assert.equal(await client.getChainId(),1301);assert.equal((await client.getBlock({blockNumber:0n})).hash.toLowerCase(),base.genesisHash.toLowerCase())
const settings=await json(join(root,'.local/playable-testnet/account-settings.json'));assert.equal(settings.chainId,1301)
const balance=await client.getBalance({address:settings.address})
const sources=['contracts/src/WorldAssetRegistry.sol','contracts/src/WorldAssetMarket.sol','contracts/src/WorldAssetSwapRouter.sol','contracts/src/AgentCityHook.sol','contracts/src/StateRegistry.sol','contracts/package-lock.json']
const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])))
for(const name of ['poolManager','quoter','CITY','GEM'])assert.equal(keccak256(await client.getCode({address:base.tokens[name]?.address||base[name]})),base.codeHashes[name])
for(const name of ['PositionManager','Permit2']){const pin=base.official?.[name];assert(pin?.address&&pin?.codeHash);assert.equal(keccak256(await client.getCode({address:pin.address})),pin.codeHash)}
if(!execute){console.log(JSON.stringify({status:balance===0n?'faucet_funding_required':'ready',chainId:1301,developer:settings.address,balanceWei:balance.toString(),maximumBudgetWei:'8000000000000000',sourceHashes,publicTransactions:0}));process.exit(balance===0n?1:0)}
await mkdir(directory,{recursive:true,mode:0o700});const release=await acquireLocalLease('agentcity-world-assets-deployment-1301');let admin,store
try{
 const path=join(directory,'deployment-progress.json');let progress=await json(path)
 const save=()=>writeCheckpoint(path,progress)
 if(!progress){progress={schema:'agentcity.world-assets-deployment.v1',runId:randomUUID(),chainId:1301,genesisHash:base.genesisHash,developer:settings.address.toLowerCase(),sourceHashes,budgetWei:'8000000000000000',operations:{}};await save()}
 assert.deepEqual(progress.sourceHashes,sourceHashes,'Keep original deployment sources/intents');assert.equal(progress.developer,settings.address.toLowerCase());assert.equal(progress.genesisHash,base.genesisHash)
 const role=async key=>{const metadata=await ensureTestnetKeystore({rootDirectory:root,privateRoot:settings.privateRoot,keyId:key,environment:'UNICHAIN_SEPOLIA_PLAYABLE'});return{metadata,account:await openDevelopmentKeystore(metadata)}}
 const registrar=await role('role-world-registrar'),publisher=await role('role-world-publisher')
 const developer=await openDevelopmentKeystore(settings)
 assert.equal(new Set([developer.address,registrar.account.address,publisher.account.address].map(a=>a.toLowerCase())).size,3)
 const db=await json(join(root,'.local/backend/environment.json'));admin=new PostgresStore(db.databaseUrl);const schema='world_assets_deployment_1301';await admin.query('CREATE SCHEMA IF NOT EXISTS '+schema)
 const url=new URL(db.databaseUrl);url.searchParams.set('options','-c search_path='+schema);store=new PostgresStore(url.toString());await store.migrate([new URL('../backend/src/chain/schema.sql',import.meta.url)])
 const evm=new PublicTestnetEvm({store,chainId:1301,rpcUrl:base.rpcUrl,genesisHash:base.genesisHash,environment:'PUBLIC_TESTNET_WORLD_ASSETS',allowedSigners:[developer.address,registrar.account.address,publisher.account.address]})
 const artifact=async name=>{
  const value=await json(join(root,'contracts/out',name+'.sol',name+'.json'));if(!value?.bytecode?.object)throw Error('Compile '+name+' before deployment')
  const source='src/'+name+'.sol';assert.equal(value.metadata?.sources?.[source]?.keccak256,keccak256(toHex(await readFile(join(root,'contracts',source)))),'Artifact source mismatch: '+name)
  return value
 }
 async function send(name,account,to,data,value=0n){
  if(!progress.operations[name]){progress.operations[name]={id:randomUUID()};await save()}
  const op=progress.operations[name];await evm.prepare(op.id,account,to,data,value);await evm.broadcast(op.id);const result=await evm.receipt(op.id,2)
  if(result.status!=='confirmed')throw Error(name+': original intent retained; reconcile before continuing')
  op.hash=result.hash;op.blockNumber=String(result.receipt.blockNumber);await save();console.log(JSON.stringify({confirmed:name,hash:op.hash}));return result.receipt
 }
 async function call(label,account,to,abi,name,args){return send(label,account,to,encodeFunctionData({abi,functionName:name,args}))}
 async function deploy(label,name,args){const a=await artifact(name),receipt=await send('deploy-'+label,developer,null,encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args}));assert(receipt.contractAddress);return receipt.contractAddress.toLowerCase()}
 await send('fund-registrar',developer,registrar.account.address,'0x',50000000000000n)
 await send('fund-state-publisher',developer,publisher.account.address,'0x',50000000000000n)
 const registry=await deploy('registry','WorldAssetRegistry',[developer.address,registrar.account.address])
 const market=await deploy('market','WorldAssetMarket',[registry,base.tokens.CITY.address])
 const serverId=keccak256(stringToHex('agentcity-playable')),deploymentId=keccak256(stringToHex('agentcity-world-assets:'+progress.runId)),marketId=keccak256(stringToHex('agentcity-world-assets-payments:'+progress.runId))
 const stateRegistry=await deploy('state-registry','StateRegistry',[publisher.account.address,marketId]),factory=await deploy('hook-factory','DemoHookFactory',[])
 const hookArtifact=await artifact('AgentCityHook'),code=encodeDeployData({abi:hookArtifact.abi,bytecode:hookArtifact.bytecode.object,args:[base.poolManager,stateRegistry,base.tokens.CITY.address,base.tokens.GEM.address]})
 let salt,hook;for(let nonce=0;;nonce++){salt=toHex(nonce,{size:32});hook=getCreate2Address({from:factory,salt,bytecodeHash:keccak256(code)});if((BigInt(hook)&0x3fffn)===0x80n)break}
 await call('deploy-hook',developer,factory,(await artifact('DemoHookFactory')).abi,'deploy',[salt,code])
 const poolKey={...base.poolKey,hooks:hook};await call('initialize-hooked-pool',developer,base.poolManager,parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160) returns(int24)']),'initialize',[poolKey,2n**96n])
 const router=await deploy('payment-router','WorldAssetSwapRouter',[base.poolManager,poolKey])
 const allowance=500n*10n**18n,permit2=base.permit2,positionManager=base.positionManager;assert(permit2&&positionManager)
 if(!progress.permitExpiry){const now=(await client.getBlock()).timestamp;progress.permitExpiry=String(now+3600n);progress.positionDeadline=String(now+1200n);await save()}
 for(const token of [poolKey.currency0,poolKey.currency1]){
  assert((await client.readContract({address:token,abi:MARKET_ABIS.token,functionName:'balanceOf',args:[developer.address]}))>=allowance,'Existing developer fixture liquidity required')
  await call('approve-permit2-'+token,developer,token,MARKET_ABIS.token,'approve',[permit2,allowance])
  await call('approve-position-'+token,developer,permit2,parseAbi(['function approve(address,address,uint160,uint48)']),'approve',[token,positionManager,allowance,Number(progress.permitExpiry)])
 }
 const mint=encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'),[poolKey,-600,600,500n*10n**18n,allowance,allowance,developer.address,'0x'])
 const settle=encodeAbiParameters(parseAbiParameters('address,address'),[poolKey.currency0,poolKey.currency1]),unlock=encodeAbiParameters(parseAbiParameters('bytes,bytes[]'),['0x020d',[mint,settle]])
 await call('seed-hooked-position',developer,positionManager,parseAbi(['function modifyLiquidities(bytes,uint256) payable']),'modifyLiquidities',[unlock,BigInt(progress.positionDeadline)])
 const payment={...base,schema:'agentcity.playable-market.v2',router,poolKey,hook:hook.toLowerCase(),stateRegistry,marketId,exactOutputEnabled:true,codeHashes:{...base.codeHashes}}
 for(const [name,address] of [['router',router],['hook',hook],['stateRegistry',stateRegistry]])payment.codeHashes[name]=keccak256(await client.getCode({address}))
 assert.equal(await client.readContract({address:router,abi:MARKET_ABIS.router,functionName:'supportsExactOutput'}),true)
 validateMarketManifest(payment)
 const manifest={schema:'agentcity.world-assets.v1',environment:'UNICHAIN_SEPOLIA_WORLD_ASSETS',chainId:1301,rpcUrl:base.rpcUrl,genesisHash:base.genesisHash,deploymentId,serverId,registry,market,city:base.tokens.CITY.address,codeHashes:{registry:keccak256(await client.getCode({address:registry})),market:keccak256(await client.getCode({address:market})),city:base.codeHashes.CITY},confirmations:2,maxPriceBaseUnits:'100000000000000000000',maxGas:'1000000',maxNativeCostWei:'2000000000000000',paymentManifest:payment,roles:{administrator:developer.address,registrar:registrar.account.address,publisher:publisher.account.address},deploymentRunId:progress.runId}
 await writeCheckpoint(join(directory,'registrar-settings.json'),registrar.metadata);await writeCheckpoint(join(directory,'publisher-settings.json'),publisher.metadata)
 await writeCheckpoint(join(directory,'payment-market.json'),payment);await writeCheckpoint(join(directory,'asset-market.json'),manifest)
 const evidence=join(root,'evidence/runs/world-assets-deployment',progress.runId);await mkdir(evidence,{recursive:true});await writeCheckpoint(join(evidence,'report.json'),{status:'pass',scope:'Actual faucet-funded Unichain Sepolia asset contracts and a new official v4 hooked pool with seeded developer fixture liquidity; no player asset registration or native ownership activation',manifest,sourceHashes,operations:progress.operations,worldAssetsIssued:0,playerPayments:0,productionWorldMutations:0,realMoneySpentUsd:0,maximumNativeBudgetWei:progress.budgetWei})
 console.log(JSON.stringify({status:'deployed',registry,market,hook,router,evidence,worldAssetsIssued:0}))
}finally{await store?.close();await admin?.close();await release()}
