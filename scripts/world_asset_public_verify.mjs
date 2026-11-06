// Read-only actual-chain verification. No keys, signer, healthy publication or swaps.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const require=createRequire(new URL('../backend/package.json',import.meta.url))
const {createPublicClient,http,keccak256,stringToHex,parseAbi,encodeAbiParameters,parseEventLogs}=require('viem')
const {unichainSepolia}=require('viem/chains')
const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'evidence/runs/world-assets-public-verify',randomUUID())
await mkdir(directory,{recursive:true})
const report={status:'fail',scope:'Actual read-only Unichain Sepolia deployment/role/hook/liquidity verification; no user asset mint, native-rights proof or production certification',checks:[],publicTransactions:0,healthyPublications:0}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
const lower=value=>value.toLowerCase(),read=async path=>JSON.parse(await readFile(path,'utf8'))
try{
 if(process.argv.length!==2)throw Error('READ_ONLY_VERIFICATION_TAKES_NO_ARGUMENTS')
 const asset=await read(join(root,'.local/world-assets/asset-market.json')),payment=await read(join(root,'.local/world-assets/payment-market.json')),progress=await read(join(root,'.local/world-assets/deployment-progress.json'))
 assert.equal(asset.schema,'agentcity.world-assets.v1');assert.equal(asset.environment,'UNICHAIN_SEPOLIA_WORLD_ASSETS');assert.equal(asset.chainId,1301);assert.equal(asset.rpcUrl,'https://sepolia.unichain.org')
 const client=createPublicClient({chain:unichainSepolia,transport:http(asset.rpcUrl,{retryCount:1,timeout:15000})})
 assert.equal(await client.getChainId(),1301);assert.equal(lower((await client.getBlock({blockNumber:0n})).hash),lower(asset.genesisHash));assert.equal(payment.genesisHash,asset.genesisHash)
 const codeTargets=[...['registry','market','city'].map(name=>({name,address:asset[name],hash:asset.codeHashes[name]})),...['poolManager','quoter','router','hook','stateRegistry'].map(name=>({name,address:payment[name],hash:payment.codeHashes[name]}))]
 report.codeHashes={}
 for(const result of await Promise.all(codeTargets.map(async target=>({...target,actual:keccak256(await client.getCode({address:target.address}))})))){assert.equal(lower(result.actual),lower(result.hash),result.name+' bytecode');report.codeHashes[result.name]={address:result.address,hash:result.actual}}
 pass('actual chain genesis and all registry market CITY official pool manager quoter hooked router state-registry bytecodes match pinned manifests')
 const viewAbi=parseAbi(['function hasRole(bytes32 role,address account) view returns(bool)','function nextTokenId() view returns(uint256)','function registry() view returns(address)','function city() view returns(address)','function poolManager() view returns(address)','function currency0() view returns(address)','function currency1() view returns(address)','function poolKey() view returns(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)','function publisher() view returns(address)','function marketId() view returns(bytes32)','function available() view returns(bool)','function extsload(bytes32 slot) view returns(bytes32)'])
 const call=(address,functionName,args=[])=>client.readContract({address,abi:viewAbi,functionName,args})
 const registrarRole=keccak256(stringToHex('REGISTRAR_ROLE')),adminRole='0x'+'0'.repeat(64)
 const roleChecks=await Promise.all([call(asset.registry,'hasRole',[registrarRole,asset.roles.registrar]),call(asset.registry,'hasRole',[adminRole,asset.roles.administrator]),call(asset.registry,'hasRole',[registrarRole,asset.roles.administrator]),call(asset.registry,'hasRole',[adminRole,asset.roles.registrar])])
 assert.deepEqual(roleChecks,[true,true,false,false]);assert.notEqual(lower(asset.roles.administrator),lower(asset.roles.registrar));assert.notEqual(lower(asset.roles.publisher),lower(asset.roles.registrar))
 const [marketRegistry,marketCity,next]=await Promise.all([call(asset.market,'registry'),call(asset.market,'city'),call(asset.registry,'nextTokenId')])
 assert.equal(lower(marketRegistry),lower(asset.registry));assert.equal(lower(marketCity),lower(asset.city));assert.equal(next,1n)
 report.nextTokenId=String(next);report.playerAssetsMinted=0;report.roles=asset.roles
 pass('actual registry administrator and registrar are distinct roles market bindings match and nextTokenId1 confirms zero assets minted')
 const [routerManager,key,hookManager,hookRegistry,currency0,currency1,publisher,marketId,available]=await Promise.all([call(payment.router,'poolManager'),call(payment.router,'poolKey'),call(payment.hook,'poolManager'),call(payment.hook,'registry'),call(payment.hook,'currency0'),call(payment.hook,'currency1'),call(payment.stateRegistry,'publisher'),call(payment.stateRegistry,'marketId'),call(payment.stateRegistry,'available')])
 assert.equal(lower(routerManager),lower(payment.poolManager));assert.equal(lower(hookManager),lower(payment.poolManager));assert.equal(lower(hookRegistry),lower(payment.stateRegistry));assert.equal(lower(publisher),lower(asset.roles.publisher));assert.equal(lower(marketId),lower(payment.marketId))
 assert.deepEqual(key.map(value=>typeof value==='string'?lower(value):Number(value)),[lower(payment.poolKey.currency0),lower(payment.poolKey.currency1),3000,60,lower(payment.hook)])
 assert.equal(lower(currency0),lower(payment.poolKey.currency0));assert.equal(lower(currency1),lower(payment.poolKey.currency1));assert.notEqual(BigInt(payment.hook)&128n,0n);assert.equal(BigInt(payment.hook)&16383n,128n)
 report.poolKey=payment.poolKey;report.stateRegistryAvailable=available
 pass('actual nonzero beforeSwap-only hook pool key immutable router currencies manager state registry publisher and market ID are bound')
 const poolId=keccak256(encodeAbiParameters([{type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]}],[payment.poolKey]))
 const hash=progress.operations['seed-hooked-position']?.hash
 assert.match(hash,/^0x[a-f0-9]{64}$/i)
 const receipt=await client.getTransactionReceipt({hash}),block=await client.getBlock({blockNumber:receipt.blockNumber}),head=await client.getBlockNumber({cacheTime:0})
 assert.equal(receipt.status,'success');assert.equal(receipt.blockHash,block.hash);assert(head-receipt.blockNumber+1n>=2n)
 const liquidityAbi=parseAbi(['event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)'])
 const logs=parseEventLogs({abi:liquidityAbi,eventName:'ModifyLiquidity',logs:receipt.logs,strict:true}).filter(log=>lower(log.address)===lower(payment.poolManager)&&log.args.id===poolId&&lower(log.args.sender)===lower(payment.positionManager)&&log.args.liquidityDelta>0n)
 assert.equal(logs.length,1)
 const stateSlot=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[poolId,6n])),liquiditySlot='0x'+(BigInt(stateSlot)+3n).toString(16).padStart(64,'0')
 const currentLiquidity=BigInt(await call(payment.poolManager,'extsload',[liquiditySlot]))&((1n<<128n)-1n)
 assert(currentLiquidity>0n)
 report.liquidity={poolId,seedTransactionHash:hash,blockHash:receipt.blockHash,blockNumber:String(receipt.blockNumber),canonicalConfirmations:String(head-receipt.blockNumber+1n),seedDelta:String(logs[0].args.liquidityDelta),currentLiquidity:String(currentLiquidity)}
 pass('actual canonical seed receipt contains exact hooked-pool positive liquidity event and current official pool liquidity remains nonzero')
 report.manifestHashes={asset:createHash('sha256').update(await readFile(join(root,'.local/world-assets/asset-market.json'))).digest('hex'),payment:createHash('sha256').update(await readFile(join(root,'.local/world-assets/payment-market.json'))).digest('hex')}
 report.status='pass'
}catch(error){report.error=String(error.shortMessage||error.message).split('\n')[0].slice(0,250);process.exitCode=1}
await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),publicTransactions:0,error:report.error}))
