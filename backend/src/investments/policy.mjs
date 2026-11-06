import {tokenAbi,positionAbi,permitAbi} from './v4.mjs'
import {swapAbi} from './swaps.mjs'

/** Enclave scope is separate from checkout. The receiving service validates every nested v4 action before signing. */
export function buildInvestmentPolicy(manifest,expiresAt) {
  if(manifest.chainId!==1301||manifest.mode!=='marketplace'||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('INVEST_TESTNET_POLICY_REQUIRED')
  const tx=(field,value)=>({field_source:'ethereum_transaction',field,operator:'eq',value})
  const data=(abi,name,field,operator,value)=>({field_source:'ethereum_calldata',abi:[abi.find(a=>a.type==='function'&&a.name===name)],field:name+'.'+field,operator,value:String(value)})
  const base=target=>[tx('chain_id','1301'),tx('to',target.toLowerCase()),tx('value','0')]
  const rule=(name,target,conditions)=>({name,method:'eth_signTransaction',action:'ALLOW',conditions:[...base(target),...conditions]})
  const tokens=[[manifest.city,10n**19n],[manifest.usdc,10n**7n]]
  const rules=tokens.flatMap(([token,cap])=>[
    rule('Bounded LP token approval',token,[data(tokenAbi,'approve','spender','eq',manifest.permit2.toLowerCase()),data(tokenAbi,'approve','amount','lte',cap)]),
    rule('Bounded expiring PositionManager allowance',manifest.permit2,[data(permitAbi,'approve','token','eq',token.toLowerCase()),data(permitAbi,'approve','spender','eq',manifest.positionManager.toLowerCase()),data(permitAbi,'approve','amount','lte',cap),data(permitAbi,'approve','expiration','lte',expiresAt)]),
    rule('Bounded guarded swap approval',token,[data(tokenAbi,'approve','spender','eq',manifest.router.toLowerCase()),data(tokenAbi,'approve','amount','lte',cap)])
  ])
  rules.push(rule('Existing PositionManager reviewed actions',manifest.positionManager,[data(positionAbi,'modifyLiquidities','deadline','lte',expiresAt)]))
  for(const [tokenIn,cap]of tokens){const tokenOut=tokens.find(([t])=>t!==tokenIn)
    rules.push(rule('Current guarded pool exact output',manifest.router,[data(swapAbi,'swapExactOutput','tokenIn','eq',tokenIn.toLowerCase()),data(swapAbi,'swapExactOutput','tokenOut','eq',tokenOut[0].toLowerCase()),
      data(swapAbi,'swapExactOutput','amountOut','gte',1),data(swapAbi,'swapExactOutput','amountOut','lte',tokenOut[1]),data(swapAbi,'swapExactOutput','maxAmountIn','lte',cap),data(swapAbi,'swapExactOutput','deadline','lte',expiresAt)]))
  }
  return {version:'1.0',chain_type:'ethereum',rules}
}
