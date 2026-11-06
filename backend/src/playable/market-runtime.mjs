import {parseSwapCommand,swapAmountRequest} from './swap-request.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { encodeFunctionData, parseEventLogs, formatEther, formatUnits } from 'viem'
import { loadPrivySettings, createTestnetWallets } from './testnet-wallets.mjs'
import { createUniswapMarket, MARKET_ABIS, validateMarketManifest } from './uniswap-market.mjs'
import { openPlayerWalletAuth } from './wallet-http-runtime.mjs'
import { createCryptoItemSales } from './crypto-sales.mjs'

const operationId=text=>{
  const hex=createHash('sha256').update(text).digest('hex').slice(0,32)
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
}
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase()
const itemTradingDisabled='Use /assets in Discord to register your exact held item, then review and confirm an on-chain CITY listing. Blockchain asset sales use verified custody and explicit owner confirmations. The old direct inventory-payout command requires operator reconciliation; no inventory or token movement was attempted.'

/** Composition only: identity, provider policy, native receipts and chain receipts retain authority. */
export function createPlayableMarketRuntime({rootDirectory,pool,pluginApi}) {
  let authPromise,marketPromise
  const login=()=>authPromise||=(openPlayerWalletAuth({pool,pluginApi}).catch(error=>{authPromise=null;throw error}))
  async function identity(event) {
    const auth=await login()
    try{return await auth.requireSession(event)}
    catch(error){
      if(['WALLET_LOGIN_REQUIRED','WALLET_AUTH_REQUIRED','WALLET_SESSION_REQUIRED','WALLET_GAME_SESSION_CHANGED','WALLET_SESSION_EXPIRED','WALLET_SESSION_NOT_AUTHENTICATED'].includes(error.code||error.message)){
        const challenge=await auth.challenge(event)
        throw Error('Sign in to your wallet for this game session: '+challenge.loginUrl)
      }
      throw error
    }
  }
  async function openMarket() {
    const loaded=await loadPrivySettings(rootDirectory)
    const bytes=await readFile(join(rootDirectory,'.local/playable-testnet/market.json'),'utf8')
    const manifest=validateMarketManifest(JSON.parse(bytes))
    if(manifest.environment!=='UNICHAIN_SEPOLIA_PLAYABLE')throw Error('PUBLIC_MANAGED_WALLET_MARKET_REQUIRED')
    const targets=[manifest.router,manifest.tokens.CITY.address,manifest.tokens.GEM.address]
    if(targets.some(address=>!loaded.settings.allowedTargets?.some(target=>same(target,address))))throw Error('MANAGED_POLICY_MARKET_TARGETS_REQUIRED')
    const wallets=await createTestnetWallets({pool,rootDirectory,provider:loaded.provider,environment:manifest.environment,
      chainId:manifest.chainId,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,
      allowBroadcast:loaded.settings.allowBroadcast===true,allowedTargets:targets,
      maxNativeBudgetWei:loaded.settings.maxNativeBudgetWei||'8000000000000000'})
    const market=await createUniswapMarket({pool,wallets,manifest,client:wallets.client})
    const manifestId=createHash('sha256').update(bytes).digest('hex')
    const sales=await createCryptoItemSales({pool,
      recipient:async playerId=>(await wallets.getOrCreate(playerId)).address,
      treasuryStatus:async terms=>{
        if(loaded.settings.allowBroadcast!==true)throw Error('Test-token payments have not been enabled by the operator. No items were removed.')
        const treasury=await wallets.getRoleWallet('treasury')
        const [balance,gas]=await Promise.all([
          wallets.client.readContract({address:manifest.tokens.CITY.address,abi:MARKET_ABIS.token,functionName:'balanceOf',args:[treasury.address]}),
          wallets.client.getBalance({address:treasury.address})])
        let gasReady=false
        if(balance>=BigInt(terms.amount)){
          const [estimate,fees]=await Promise.all([
            wallets.client.estimateContractGas({account:treasury.address,address:manifest.tokens.CITY.address,abi:MARKET_ABIS.token,functionName:'transfer',args:[terms.recipient,BigInt(terms.amount)]}),
            wallets.client.estimateFeesPerGas()])
          const gasLimit=estimate*125n/100n+10000n
          const fee=fees.maxFeePerGas??fees.gasPrice
          if(fee===undefined)throw Error('TREASURY_GAS_QUOTE_UNAVAILABLE')
          const required=gasLimit*fee*2n
          gasReady=gasLimit<=BigInt(manifest.maxGas)&&required<=BigInt(manifest.maxNativeCostWei)&&gas>=required
        }
        return{chainId:manifest.chainId,token:manifest.tokens.CITY.address,decimals:18,address:treasury.address,
          balance:String(balance),gasReady,manifestId}
      },removeInventory:request=>pluginApi('sell',request),
      payout:async sale=>{
        if(sale.manifestId!==manifestId||sale.chainId!==manifest.chainId||!same(sale.token,manifest.tokens.CITY.address))throw Error('PAYOUT_MARKET_BINDING_CHANGED')
        const treasury=await wallets.getRoleWallet('treasury')
        if(!same(treasury.address,sale.treasury))throw Error('PAYOUT_TREASURY_CHANGED')
        const id=operationId(sale.operationId),data=encodeFunctionData({abi:MARKET_ABIS.token,functionName:'transfer',args:[sale.recipient,BigInt(sale.amount)]})
        const request={role:'treasury',operationId:id,to:sale.token,data,value:0n,limits:{maxGas:manifest.maxGas,maxNativeCostWei:manifest.maxNativeCostWei}}
        await wallets.prepare(request);await wallets.broadcast({role:'treasury',operationId:id})
        const result=await wallets.reconcile({role:'treasury',operationId:id})
        if(result.status!=='confirmed')return{status:result.status}
        const hash=result.transactionHash||result.hash
        const [transaction,receipt]=await Promise.all([wallets.client.getTransaction({hash}),wallets.client.getTransactionReceipt({hash})])
        const block=await wallets.client.getBlock({blockNumber:receipt.blockNumber})
        if(receipt.status!=='success'||receipt.blockHash!==block.hash||!same(transaction.from,sale.treasury)||!same(transaction.to,sale.token)||transaction.input.toLowerCase()!==data.toLowerCase()||transaction.value!==0n)throw Error('PAYOUT_CANONICAL_RECEIPT_REQUIRED')
        const transfers=parseEventLogs({abi:MARKET_ABIS.token,eventName:'Transfer',logs:receipt.logs,strict:true}).filter(log=>same(log.address,sale.token)&&same(log.args.from,sale.treasury)&&same(log.args.to,sale.recipient))
        if(transfers.length!==1||transfers[0].args.value!==BigInt(sale.amount))throw Error('PAYOUT_TOKEN_TRANSFER_REQUIRED')
        return{status:'confirmed',chainId:manifest.chainId,token:sale.token,from:sale.treasury,to:sale.recipient,amount:sale.amount,transactionHash:hash}
      }})
    return{market,wallets,sales,settings:loaded.settings}
  }
  const configured=()=>marketPromise||=(openMarket().catch(error=>{marketPromise=null;throw error}))
  async function ready(event) {
    const verified=await identity(event),runtime=await configured()
    await runtime.wallets.getOrCreate(event.playerId,{subject:verified.privySubject})
    return runtime
  }
  const quoteMessage=quote=>{
    if (quote.kind === 'exact_output') {
      if (quote.status === 'confirmed') {
        const actual = quote.proof?.swap?.amountInBaseUnits
        return `Swap confirmed: received exactly ${quote.quotedOut} ${quote.tokenOut}; ${actual === undefined ? 'see receipt for actual input' : 'spent '+formatUnits(BigInt(actual),18)+' '+quote.tokenIn}. ${quote.proof?.swap?.transactionHash || ''}`
      }
      if (!quote.consented && !['expired','reverted'].includes(quote.status)) return `Quote ${quote.previewId}: receive exactly ${quote.quotedOut} ${quote.tokenOut}; estimated ${quote.amountIn} ${quote.tokenIn}, maximum ${quote.maxAmountIn} ${quote.tokenIn}. Deadline ${new Date(quote.deadline*1000).toISOString()}. Gas is paid separately. Confirm explicitly with /swap confirm ${quote.previewId}.`
    }
    if(quote.status==='confirmed'){
      const actual=quote.proof?.swap?.amountOutBaseUnits
      return `Swap confirmed: ${quote.amountIn} ${quote.tokenIn}${actual!==undefined?' for '+formatUnits(BigInt(actual),18)+' '+quote.tokenOut:''}. ${quote.proof?.swap?.transactionHash||''}`
    }
    if(['expired','reverted'].includes(quote.status))return `Swap ${quote.previewId}: ${quote.status}. This quote will not be replaced automatically. Review its retained status before requesting a new quote.`
    if(quote.status==='previewed'||!quote.consented)return `Quote ${quote.previewId}: ${quote.amountIn} ${quote.tokenIn} -> about ${quote.quotedOut} ${quote.tokenOut}; minimum ${quote.minimumOut}, slippage ${quote.slippageBps/100}%. Deadline ${new Date(quote.deadline*1000).toISOString()}. Gas is paid separately. Confirm explicitly with /swap confirm ${quote.previewId}.`
    return `Swap ${quote.previewId}: ${quote.status}. Use /swap retry ${quote.previewId} to reconcile this operation.`
  }
  return {
    async handle(event) {
      if(event.action==='crypto_sell')return itemTradingDisabled
      if(event.action==='crypto_wallet'){
        const auth=await login()
        try{await auth.requireSession(event)}catch(error){const request=await auth.challenge(event);return `Sign in with email or passkey for this game connection: ${request.loginUrl}. Your first identity link requires operator enrollment.`}
      }
      const runtime=await ready(event)
      if(event.action==='crypto_wallet'||event.action==='crypto_market'){
        const balances=await runtime.market.balances({playerId:event.playerId}),history=await runtime.market.history({playerId:event.playerId})
        return `Privy-managed testnet wallet ${balances.address}. Unichain Sepolia (1301). ETH ${formatEther(BigInt(balances.nativeBalanceWei))}; CITY ${balances.tokens.CITY.amount}; GEM ${balances.tokens.GEM.amount}. Uniswap v4: /swap <amount> CITY GEM or GEM CITY. Latest swap: ${history[0]?.status||'none'}. /balance is your separate Game Coins ledger.`
      }
      if(event.action==='crypto_swap'){
        let quote
        if (['confirm','retry'].includes(event.args[0])) {
          quote = await runtime.market[event.args[0]]({playerId:event.playerId,previewId:event.args[1]})
        } else {
          const request = parseSwapCommand(event.args)
          quote = await runtime.market.preview({playerId:event.playerId,operationId:operationId(event.operationId),
            ...swapAmountRequest(request),tokenIn:request.tokenIn,tokenOut:request.tokenOut})
        }
        return quoteMessage(quote)
      }
      throw Error('UNKNOWN_TESTNET_ACTION')
    },
    async context() {
      try{await configured();return{marketAvailable:true,supportedAssets:['CITY','GEM'],prices:{}}}
      catch{return{marketAvailable:false,supportedAssets:[],prices:{}}}
    },
    async agentStep(event,step) {
      if(step.action==='market')return{complete:false,message:itemTradingDisabled}
      const runtime=await ready(event)
      if(step.action==='wallet'){
        const balance=await runtime.market.balances({playerId:event.playerId})
        return{complete:true,message:`Your managed testnet wallet has ${balance.tokens.CITY.amount} CITY, ${balance.tokens.GEM.amount} GEM and ${formatEther(BigInt(balance.nativeBalanceWei))} test ETH on Unichain Sepolia.`}
      }
      if(step.action==='swap'){
        const id=operationId(event.operationId)
        let quote
        try{quote=await runtime.market.getPreview({playerId:event.playerId,previewId:id})}
        catch(error){if(error.message!=='MARKET_PREVIEW_OWNER_REQUIRED')throw error;quote=await runtime.market.preview({playerId:event.playerId,operationId:id,amountIn:step.amountIn,tokenIn:step.tokenIn,tokenOut:step.tokenOut})}
        return{complete:quote.status==='confirmed',message:quoteMessage(quote)}
      }
      throw Error('UNSUPPORTED_MARKET_STEP')
    }
  }
}
