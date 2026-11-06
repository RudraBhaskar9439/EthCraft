import {readFile,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {keccak256,parseAbi} from 'viem'
import {createBankRpcClient} from '../bank/rpc.mjs'
import {loadPrivySettings,createPrivyManagedProvider,createTestnetWallets} from '../playable/testnet-wallets.mjs'
import {createInvestmentService} from './service.mjs'
import {positionAbi,poolId} from './v4.mjs'
import {loadUniswapKey,createUniswapApi,approvedRoute} from './uniswap-api.mjs'

const fail=code=>{throw Object.assign(Error(code),{code})}
const json=async path=>JSON.parse(await readFile(path,'utf8'))
const addressAbi=parseAbi(['function poolManager() view returns(address)','function permit2() view returns(address)'])
export async function openInvestmentRuntime({root,pool,identity,serverId,gameSession}) {
  const manifest=await json(join(root,'.local/marketplace/public-deployment.json'))
  if(manifest.chainId!==1301||manifest.mode!=='marketplace'||manifest.serverIdText!==serverId)fail('INVEST_CURRENT_TESTNET_DEPLOYMENT_REQUIRED')
  const client=await createBankRpcClient(manifest)
  const verifyDeployment=async()=>{
    const config=await json(join(root,'.local/investments/deployment.json')).catch(()=>fail('INVEST_DEPLOYMENT_PREFLIGHT_REQUIRED'))
    if(config.chainId!==1301||config.deploymentId!==manifest.deploymentId||config.positionManager!==manifest.positionManager.toLowerCase()||
      config.permit2!==manifest.permit2.toLowerCase()||config.poolId!==poolId(manifest.pools.cityUsdc))fail('INVEST_PINNED_DEPLOYMENT_CHANGED')
    if(await client.getChainId()!==1301||(await client.getBlock({blockNumber:0n})).hash!==manifest.genesisHash)fail('INVEST_CHAIN_CHANGED')
    const expected={...manifest.codeHashes,positionManager:config.codeHashes.positionManager,permit2:config.codeHashes.permit2}
    for(const [name,hash] of Object.entries(expected)){
      const code=await client.getCode({address:manifest[name]})
      if(!/^0x[a-f0-9]{64}$/i.test(hash||'')||!code||code==='0x'||keccak256(code).toLowerCase()!==hash.toLowerCase())fail('INVEST_CONTRACT_CODE_CHANGED')
    }
    for(const [name,value] of [['poolManager',manifest.poolManager],['permit2',manifest.permit2]]){
      if((await client.readContract({address:manifest.positionManager,abi:addressAbi,functionName:name})).toLowerCase()!==value.toLowerCase())fail('INVEST_POSITION_MANAGER_BINDING_CHANGED')
    }
    return {deploymentId:manifest.deploymentId,positionManager:config.codeHashes.positionManager,permit2:config.codeHashes.permit2,hook:manifest.codeHashes.hook,router:manifest.codeHashes.router}
  }
  let wallets,api
  let configuredPrincipal
  let configuredExpiry=0
  const getApi=async()=>api||(api=createUniswapApi({key:await loadUniswapKey(root)}))
  const getSigner=async actor=>{
    if(wallets){if(actor.owner.ownerId!==configuredPrincipal)fail('INVEST_SEPARATE_PRIVY_POLICY_REQUIRED');if(Date.now()>=configuredExpiry)fail('INVEST_DELEGATION_EXPIRED');return wallets}
    const path=join(root,'.local/investments/privy.json')
    const stat=await lstat(path).catch(()=>fail('INVEST_SEPARATE_PRIVY_POLICY_REQUIRED'))
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077)fail('INVEST_PRIVATE_SIGNER_CONFIGURATION_REQUIRED')
    const config=await json(path),{settings,credentials}=await loadPrivySettings(root,{requireProvider:false})
    if(!Number.isSafeInteger(config.expiresAt)||Date.now()>=config.expiresAt*1000)fail('INVEST_DELEGATION_EXPIRED')
    if(config.enabled!==true||config.chainId!==1301||config.deploymentId!==manifest.deploymentId||config.delegateQuorumId===settings.delegateQuorumId||
      config.delegateQuorumId===settings.ownerQuorumId||!config.principalId||config.principalId!==actor.owner.ownerId||
      !settings.walletBindings?.[actor.wallet.externalId]||JSON.stringify(settings.walletBindings[actor.wallet.externalId])!==JSON.stringify(config.walletBinding))fail('INVEST_SEPARATE_PRIVY_POLICY_REQUIRED')
    const allowedTargets=[manifest.city,manifest.usdc,manifest.permit2,manifest.positionManager,manifest.router].map(a=>a.toLowerCase())
    const provider=createPrivyManagedProvider({appId:settings.appId,appSecret:credentials.appSecret,ownerPublicKey:credentials.ownerPublicKey,ownerQuorumId:settings.ownerQuorumId,
      delegateAuthorizationPrivateKey:credentials.investmentDelegateAuthorizationPrivateKey,delegatePublicKey:config.delegatePublicKey,delegateQuorumId:config.delegateQuorumId,
      policyId:config.policyId,policySha256:config.policySha256,allowedTargets,walletBinding:config.walletBinding})
    await provider.validateConfiguration()
    // Same player wallet tables, nonce allocator and cumulative gas reservations as shop checkout.
    wallets=await createTestnetWallets({pool,rootDirectory:root,environment:'UNICHAIN_SEPOLIA_PLAYABLE',chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,
      allowedTargets,allowBroadcast:true,maxNativeBudgetWei:settings.maxNativeBudgetWei,provider})
    configuredPrincipal=actor.owner.ownerId
    configuredExpiry=config.expiresAt*1000
    return wallets
  }
  let recoveryWallets
  const getRecoverySigner=async actor=>{
    if(!recoveryWallets){const {settings}=await loadPrivySettings(root,{requireProvider:false})
      recoveryWallets=await createTestnetWallets({pool,rootDirectory:root,environment:'UNICHAIN_SEPOLIA_PLAYABLE',chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,
        allowedTargets:[manifest.city,manifest.usdc,manifest.permit2,manifest.positionManager,manifest.router],allowBroadcast:true,maxNativeBudgetWei:settings.maxNativeBudgetWei})}
    return {prepare:async input=>(await getSigner(actor)).prepare(input),broadcast:input=>recoveryWallets.broadcast(input),reconcile:input=>recoveryWallets.reconcile(input)}
  }
  const service=await createInvestmentService({pool,manifest,client,identity,serverId,gameSession,verifyDeployment,getSigner,getRecoverySigner})
  async function support(){
    const api=await getApi(),[registry,currentPool]=await Promise.all([api.supportedChains(),api.poolInfo(manifest.pools.cityUsdc)])
    const chain=registry.chains?.find(c=>c.chainId===1301)
    return {chainId:1301,apiChainSupported:!!chain,protocols:chain?.protocols||[],actions:chain?.actions||[],cityPoolApiIndexed:Array.isArray(currentPool.pools)&&currentPool.pools.length>0,
      cityLpRoute:'Official SDK math + existing deployed PositionManager; no migration',protectedApiSubmissionVerified:false,realTransaction:false}
  }
  async function routes(input){
    const state=await service.portfolio(input),config=await json(join(root,'.local/investments/deployment.json'))
    const tokens={CITY:manifest.city,tUSDC:manifest.usdc,GEM:manifest.gem}
    if(!tokens[input.tokenIn]||!tokens[input.tokenOut]||input.tokenIn===input.tokenOut||!/^[1-9][0-9]{0,19}$/.test(input.amountOut||''))fail('INVEST_APPROVED_TEST_TOKEN_REQUIRED')
    const result=await Promise.all(['V3','V4'].map(async protocol=>{
      try{
        const quote=await(await getApi()).quote({tokenIn:tokens[input.tokenIn],tokenOut:tokens[input.tokenOut],amount:input.amountOut,swapper:state.walletAddress,protocols:[protocol]})
        const route=approvedRoute(quote,config.approvedApiPools||[],Object.values(tokens).map(a=>a.toLowerCase()),state.walletAddress)
        return {protocol,...route,executable:false,blocker:'INVEST_PROTECTED_ROUTE_NOT_VERIFIED'}
      }catch(error){return {protocol,executable:false,blocker:/^INVEST_[A-Z0-9_]+$/.test(error.code||'')?error.code:'INVEST_API_ROUTE_UNAVAILABLE'}}
    }))
    return {mode:'investment',chainId:1301,realTransaction:false,simulated:false,quotesOnly:true,routes:result,
      message:'API quotes are not payments. Execution is disabled until every pool is explicitly approved and protected execution is verified. No public-route fallback.'}
  }
  return {...service,support,routes,verifyDeployment,client,manifest}
}
