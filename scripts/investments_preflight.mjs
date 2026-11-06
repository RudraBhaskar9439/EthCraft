// Read-only live/API verification. Writes only a separate ignored investment pin file.
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createBankRpcClient} from '../backend/src/bank/rpc.mjs'
import {loadUniswapKey,createUniswapApi} from '../backend/src/investments/uniswap-api.mjs'
import {positionAbi,poolId,readPool,readPosition} from '../backend/src/investments/v4.mjs'
const require=createRequire(new URL('../backend/package.json',import.meta.url)),{keccak256}=require('viem')
const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'.local/investments')
const manifest=JSON.parse(await readFile(join(root,'.local/marketplace/public-deployment.json'),'utf8'))
assert.equal(manifest.chainId,1301);assert.equal(manifest.mode,'marketplace')
const client=await createBankRpcClient(manifest)
assert.equal(await client.getChainId(),1301)
assert.equal((await client.getBlock({blockNumber:0n})).hash,manifest.genesisHash)
for(const [key,hash]of Object.entries(manifest.codeHashes))assert.equal(keccak256(await client.getCode({address:manifest[key]})),hash)
for(const [key,value]of [['poolManager',manifest.poolManager],['permit2',manifest.permit2]])assert.equal((await client.readContract({address:manifest.positionManager,abi:positionAbi,functionName:key})).toLowerCase(),value.toLowerCase())
const pins={chainId:1301,deploymentId:manifest.deploymentId,positionManager:manifest.positionManager.toLowerCase(),permit2:manifest.permit2.toLowerCase(),poolId:poolId(manifest.pools.cityUsdc),codeHashes:{},approvedApiPools:[]}
for(const key of ['positionManager','permit2']){const code=await client.getCode({address:manifest[key]});assert(code&&code!=='0x');pins.codeHashes[key]=keccak256(code)}
try {const old=JSON.parse(await readFile(join(directory,'deployment.json'),'utf8'));assert.deepEqual({...old,approvedApiPools:[]},pins,'Existing investment pins changed; refuse to overwrite');pins.approvedApiPools=old.approvedApiPools}
catch(error){if(error.code!=='ENOENT')throw error}
const api=createUniswapApi({key:await loadUniswapKey(root)})
const chains=await api.supportedChains(),chain=chains.chains?.find(c=>c.chainId===1301)
assert(chain,'API no longer advertises Unichain Sepolia')
const cityPool=await api.poolInfo(manifest.pools.cityUsdc)
const block=await client.getBlock(),pool=await readPool(client,manifest,block.number)
const config=JSON.parse(await readFile(join(root,'.local/bank/operator-settings.json'),'utf8'))
const report={checkedAt:new Date().toISOString(),chainId:1301,actions:chain.actions,protocols:chain.protocols,
  cityPoolApiIndexed:Array.isArray(cityPool.pools)&&cityPool.pools.length>0,cityLpRoute:'Existing official PositionManager with official SDK liquidity math',
  blockNumber:String(block.number),poolId:pool.id,tick:pool.tick,activeLiquidity:String(pool.liquidity),signedTransactions:0,protectedApiSubmissionVerified:false,
  blockers:['No external API pools approved or protected submission verified.'],positions:[],apiRoutes:[]}
try{const policy=JSON.parse(await readFile(join(directory,'privy.json'),'utf8'));report.investmentDelegateConfigured=policy.enabled===true&&policy.deploymentId===manifest.deploymentId&&policy.expiresAt>Math.floor(Date.now()/1000)}catch{report.investmentDelegateConfigured=false}
if(!report.investmentDelegateConfigured)report.blockers.push('Separate Privy investment delegate/policy is not installed or has expired. Shop signing permission is unchanged.')
for(const protocol of ['V3','V4']){
  try{const quote=await api.quote({tokenIn:manifest.city,tokenOut:manifest.usdc,amount:'1000000',swapper:config.roles.liquidity.address,protocols:[protocol]});report.apiRoutes.push({protocol,responseRouting:quote.routing,executable:false})}
  catch(error){report.apiRoutes.push({protocol,result:error.code||'API_ROUTE_NOT_VERIFIED',executable:false})}
}
for(const id of [manifest.marketplace?.initialLiquidity?.positionId].filter(Boolean)){
  const p=await readPosition(client,manifest,id,config.roles.liquidity.address,{blockNumber:block.number,pool})
  report.positions.push({tokenId:p.tokenId,owner:p.owner,liquidity:p.liquidity,inRange:p.inRange,fees:p.fees})
}
await mkdir(directory,{recursive:true,mode:0o700})
await writeFile(join(directory,'deployment.json'),JSON.stringify(pins,null,2)+'\n',{mode:0o600})
await writeFile(join(directory,'preflight.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify(report,null,2))
