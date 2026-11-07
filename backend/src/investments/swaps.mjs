import {encodeFunctionData,encodeAbiParameters,parseAbiParameters,parseAbi,keccak256,stringToHex,formatUnits} from 'viem'
import {tokenAbi} from './v4.mjs'

export const swapAbi=parseAbi(['function swapExactOutput(bytes32 operationId,address tokenIn,address tokenOut,uint128 amountOut,uint128 maxAmountIn,uint48 deadline) returns(uint256)'])
const quoterAbi=parseAbi(['function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountIn,uint256 gasEstimate)'])
const hookAbi=parseAbi(['function marketReference() view returns(bool ready,int24 meanTick,uint64 anchorTimestamp,uint64 age)','function feeFor(address) view returns(uint24)'])
const fail=code=>{throw Object.assign(Error(code),{code})}

/** Current hooked pool only. Unprotected multi-hop pools never inherit this pool's protection. */
export async function previewGuardedSwap({manifest,client,snapshot,input,owner,operationId}) {
  const tokens={CITY:{address:manifest.city,decimals:18},tUSDC:{address:manifest.usdc,decimals:6}}
  const a=tokens[input.tokenIn],b=tokens[input.tokenOut]
  if(!a||!b||a===b)fail('INVEST_MULTIPOOL_PROTECTION_UNAVAILABLE')
  if(!/^[1-9][0-9]{0,19}$/.test(input.amountOut||'')||!/^[1-9][0-9]{0,19}$/.test(input.maximumInput||''))fail('INVEST_SWAP_AMOUNTS_REQUIRED')
  const amountOut=BigInt(input.amountOut),maximum=BigInt(input.maximumInput)
  if(amountOut>10n*10n**BigInt(b.decimals)||maximum>10n*10n**BigInt(a.decimals))fail('INVEST_SWAP_AMOUNT_CAP')
  const key=manifest.pools.cityUsdc,zeroForOne=a.address.toLowerCase()===key.currency0.toLowerCase()
  const reference=await client.readContract({address:manifest.hook,abi:hookAbi,functionName:'marketReference',blockNumber:snapshot.blockNumber})
  if(!reference[0])fail('INVEST_REFERENCE_NOT_READY')
  const fee=await client.readContract({address:manifest.hook,abi:hookAbi,functionName:'feeFor',args:[owner],blockNumber:snapshot.blockNumber})
  const quote=await client.simulateContract({address:manifest.quoter,abi:quoterAbi,functionName:'quoteExactOutputSingle',account:owner,
    args:[{poolKey:key,zeroForOne,exactAmount:amountOut,hookData:encodeAbiParameters(parseAbiParameters('address'),[owner])}],blockNumber:snapshot.blockNumber})
  const expected=BigInt(quote.result[0]),maxInput=(expected*10050n+9999n)/10000n
  if(maxInput>maximum)fail('INVEST_MAXIMUM_INPUT_TOO_LOW')
  const deadline=snapshot.timestamp+110
  const call={to:manifest.router.toLowerCase(),value:'0',data:encodeFunctionData({abi:swapAbi,functionName:'swapExactOutput',args:[keccak256(stringToHex(operationId)),a.address,b.address,amountOut,maxInput,deadline]})}
  const approval=value=>({to:a.address.toLowerCase(),value:'0',data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[manifest.router,value]})})
  const allowance=await client.readContract({address:a.address,abi:tokenAbi,functionName:'allowance',args:[owner,manifest.router],blockNumber:snapshot.blockNumber})
  const approvals=allowance>=maxInput?[]:[...(allowance>0n?[approval(0n)]:[]),approval(maxInput)]
  // The exact fixed 0.5% maximum is reviewable; agents have no parameter to widen it.
  const spotInput=zeroForOne?amountOut*(1n<<192n)/(snapshot.pool.sqrtPriceX96**2n):amountOut*snapshot.pool.sqrtPriceX96**2n/(1n<<192n)
  const impact=spotInput?Number((expected-spotInput)*10000n/spotInput)/100:null
  return {action:'swap',owner:owner.toLowerCase(),deadline:String(deadline),call,calls:[...approvals,call],
    tokenIn:input.tokenIn,tokenOut:input.tokenOut,expectedInput:String(expected),maximumInput:String(maxInput),amountOut:String(amountOut),
    slippageBps:50,lines:[`Swap ${input.tokenIn} to ${input.tokenOut}`,`Wallet / recipient: ${owner}`,`Receive exactly: ${formatUnits(amountOut,b.decimals)} ${input.tokenOut}`,
      `Expected input: ${formatUnits(expected,a.decimals)} ${input.tokenIn}`,`Maximum spend: ${formatUnits(maxInput,a.decimals)} ${input.tokenIn}`,
      `Pool fee now: ${Number(fee)/10000}% (dynamic, capped at 1%)`,`Execution vs spot including fee: ${impact??'unavailable'}%`,
      `Route: existing guarded CITY/tUSDC pool; official V4Quoter`,`Submission: public RPC with on-chain hook checks. No private ordering guarantee.`,
      `Expiry: ${new Date(deadline*1000).toISOString()}`,`Slippage: 0.5%; no automatic widening`]}
}
