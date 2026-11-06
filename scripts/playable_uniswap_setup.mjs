// Create/reuse a separate local v4 CITY/GEM market. Never touch 8547 or old KIT.
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { MARKET_ABIS, validateMarketManifest } from '../backend/src/playable/uniswap-market.mjs'
const require=createRequire(new URL('../backend/package.json',import.meta.url))
const {createPublicClient,http,keccak256,getAddress}=require('viem')
const {foundry}=require('viem/chains')
const root=fileURLToPath(new URL('../',import.meta.url))
const directory=join(root,'.local/playable-market')
const manifestFile=join(directory,'deployment.json')
const ownerFile=join(directory,'anvil-environment.json')
const progressFile=join(directory,'setup-started.json')
const rpcUrl='http://127.0.0.1:8559'
const client=createPublicClient({chain:foundry,transport:http(rpcUrl,{retryCount:0,timeout:15000})})
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
async function json(path){try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function privateJson(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600})}
async function sourceHashes(){const paths=['contracts/src/PlayableMarketRouter.sol','contracts/src/PlayableMarketToken.sol','contracts/script/PlayableMarketLocal.s.sol','contracts/package-lock.json'];return Object.fromEntries(await Promise.all(paths.map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])))}

if(process.platform==='win32')throw Error('Run this setup in WSL; the managed-wallet lane uses Unix-private keystores.')
await mkdir(directory,{recursive:true,mode:0o700})
await mkdir(join(root,'contracts/.local'),{recursive:true,mode:0o700})
const tools=process.platform==='darwin'?join(homedir(),'.foundry/bin'):join(root,'.local/tools/foundry-linux')
const anvil=join(tools,'anvil'),forge=join(tools,'forge')
for(const [name,path]of[['anvil',anvil],['forge',forge]]){
  const version=spawnSync(path,['--version'],{encoding:'utf8',timeout:10000})
  if(version.status!==0||!new RegExp('^'+name+' Version: 1\\.7\\.1\\b','m').test(version.stdout))throw Error('Pinned Foundry 1.7.1 is required.')
}
let owned=await json(ownerFile),connected=false
try{const chainId=await client.getChainId();if(chainId!==31337)throw Error('FOREIGN_MARKET_CHAIN');connected=true}catch(error){if(error.message==='FOREIGN_MARKET_CHAIN')throw error}
if(!connected){
  if(owned)throw Error('Owned market node is offline. Preserve its state; do not silently create a new chain instance.')
  const output=await open(join(directory,'anvil.log'),'a',0o600)
  const childProcess=spawn(anvil,['--host','127.0.0.1','--port','8559','--chain-id','31337','--silent'],{cwd:root,stdio:['ignore',output.fd,output.fd],detached:true})
  childProcess.unref();await output.close()
  for(let attempt=0;attempt<80;attempt++){
    try{connected=(await client.getChainId())===31337;if(connected)break}catch{}
    await delay(100)
  }
  if(!connected)throw Error('Dedicated market Anvil did not start; inspect its owned log.')
  owned={owner:'agentcity-playable-market',pid:childProcess.pid,rpcUrl,chainId:31337,genesisHash:(await client.getBlock({blockNumber:0n})).hash}
  await privateJson(ownerFile,owned)
}else if(!owned)throw Error('Port 8559 is occupied by an unowned node; it was not modified.')
if(owned.owner!=='agentcity-playable-market'||owned.rpcUrl!==rpcUrl||owned.genesisHash!==(await client.getBlock({blockNumber:0n})).hash)throw Error('Dedicated market chain identity changed.')
let manifest=await json(manifestFile)
if(manifest){
  manifest=validateMarketManifest(manifest)
  for(const key of['poolManager','quoter','router','CITY','GEM']){
    const code=await client.getCode({address:manifest.tokens[key]?.address||manifest[key]})
    if(!code||keccak256(code)!==manifest.codeHashes[key])throw Error('Existing dedicated market code differs: '+key)
  }
  console.log(JSON.stringify({status:'pass',reused:true,rpcUrl,manifest:manifestFile,scope:'local new CITY/GEM pool; old market unchanged'}))
}else{
  if(await json(progressFile))throw Error('A prior deployment was started. Reconcile its original Forge broadcast before retrying; no second deployment was made.')
  const accounts=await client.request({method:'eth_accounts'})
  if(accounts.length<7)throw Error('Distinct local administrator and issuer fixture accounts are required.')
  const hashes=await sourceHashes()
  await privateJson(progressFile,{owner:owned.owner,genesisHash:owned.genesisHash,administrator:accounts[0],issuer:accounts[6],sources:hashes,startedAt:new Date().toISOString()})
  const log=await open(join(directory,'deployment.log'),'a',0o600)
  const status=await new Promise((resolve,reject)=>{
    const child=spawn(forge,['script','script/PlayableMarketLocal.s.sol:PlayableMarketLocal','--rpc-url',rpcUrl,'--unlocked','--broadcast','--slow','--sender',accounts[0]],
      {cwd:join(root,'contracts'),env:{...process.env,PLAYABLE_MARKET_ADMIN:accounts[0],PLAYABLE_MARKET_ISSUER:accounts[6],PLAYABLE_MARKET_OUTPUT:'.local/playable-market-deployment.json'},stdio:['ignore',log.fd,log.fd]})
    child.on('error',reject);child.on('exit',resolve)
  })
  await log.close()
  if(status!==0)throw Error('Dedicated market deployment failed; original progress and broadcast records were preserved.')
  const deployed=await json(join(root,'contracts/.local/playable-market-deployment.json'))
  if(!deployed)throw Error('Deployment output missing; do not redeploy without reconciling the original run.')
  const codes={}
  for(const key of['poolManager','quoter','router','CITY','GEM']){
    const code=await client.getCode({address:deployed[key]})
    if(!code||code==='0x')throw Error('Deployed contract code missing: '+key)
    codes[key]=keccak256(code)
  }
  manifest=validateMarketManifest({schema:'agentcity.playable-market.v1',environment:'LOCAL_TEST_FIXTURE',chainId:31337,rpcUrl,genesisHash:owned.genesisHash,
    poolManager:deployed.poolManager,quoter:deployed.quoter,router:deployed.router,
    tokens:{CITY:{address:deployed.CITY,decimals:18},GEM:{address:deployed.GEM,decimals:18}},
    poolKey:{currency0:getAddress(deployed.currency0).toLowerCase(),currency1:getAddress(deployed.currency1).toLowerCase(),fee:3000,tickSpacing:60,hooks:'0x0000000000000000000000000000000000000000'},
    codeHashes:codes,exactOutputEnabled:true,maxInputBaseUnits:String(100n*10n**18n),maxNativeCostWei:'2000000000000000',
    localFixture:{administrator:deployed.administrator,issuer:deployed.issuer,liquidityHelper:deployed.localLiquidityFixture,issuedEachToken:'100000000000000000000000',liquidity:'10000000000000000000000',ticks:[-600,600],testOnly:true},
    sourceHashes:hashes,gameCoinsBacked:false,minecraftInventoryBacked:false})
  for(const symbol of['CITY','GEM']){
    const token=manifest.tokens[symbol].address
    if(await client.readContract({address:token,abi:MARKET_ABIS.token,functionName:'symbol'})!==symbol)throw Error('Dedicated token identity check failed.')
  }
  if(await client.readContract({address:manifest.router,abi:MARKET_ABIS.router,functionName:'supportsExactOutput'})!==true)throw Error('Exact-output router capability check failed.')
  await privateJson(manifestFile,manifest)
  console.log(JSON.stringify({status:'pass',reused:false,rpcUrl,manifest:manifestFile,contracts:{poolManager:manifest.poolManager,quoter:manifest.quoter,router:manifest.router,CITY:manifest.tokens.CITY.address,GEM:manifest.tokens.GEM.address},scope:'actual new local v4 market with disclosed test liquidity; no public deployment'}))
}
