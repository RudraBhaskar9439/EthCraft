import {readFile,lstat} from 'node:fs/promises'
import {join} from 'node:path'

const fail=code=>{throw Object.assign(Error(code),{code})}
export async function loadUniswapKey(root) {
  const path=join(root,'.local/investments/uniswap.env'), info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077)fail('INVEST_PRIVATE_API_KEY_FILE_REQUIRED')
  const match=(await readFile(path,'utf8')).match(/^UNISWAP_API_KEY=["']?([A-Za-z0-9_-]+)["']?\s*$/m)
  if(!match)fail('INVEST_UNISWAP_API_KEY_REQUIRED')
  return match[1]
}

/** Fixed official hosts. Responses are proposals; this client never signs their calldata. */
export function createUniswapApi({key,fetcher=fetch}) {
  async function request(path,body,liquidity=false) {
    const response=await fetcher((liquidity?'https://liquidity.api.uniswap.org':'https://trade-api.gateway.uniswap.org/v1')+path,{
      method:body?'POST':'GET',headers:{'x-api-key':key,'Content-Type':'application/json','x-universal-router-version':'2.0'},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)})
    const reader=response.body.getReader();let size=0;const chunks=[]
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();fail('INVEST_UNISWAP_RESPONSE_TOO_LARGE')}chunks.push(Buffer.from(value))}
    let result
    try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail('INVEST_UNISWAP_INVALID_RESPONSE')}
    if(!response.ok)fail(result.errorCode==='NoRouteFoundError'?'INVEST_UNISWAP_NO_ROUTE':'INVEST_UNISWAP_HTTP_'+response.status)
    return result
  }
  return {
    supportedChains:()=>request('/supported_chains'),
    poolInfo:key=>request('/lp/pool_info',{protocol:'V4',chainId:1301,poolParameters:{tokenAddressA:key.currency0,tokenAddressB:key.currency1,fee:Number(key.fee),tickSpacing:Number(key.tickSpacing),hookAddress:key.hooks}},true),
    // Classic-only exact-output proposals; no UniswapX, bridges, typed permits or arbitrary API transactions.
    quote:({tokenIn,tokenOut,amount,swapper,protocols})=>request('/quote',{type:'EXACT_OUTPUT',amount:String(amount),tokenInChainId:1301,tokenOutChainId:1301,
      tokenIn,tokenOut,swapper,protocols,slippageTolerance:0.5,routingPreference:'BEST_PRICE'})
  }
}

export function approvedRoute(response, approvedPools, approvedTokens, recipient) {
  const quote=response?.quote
  if(response?.routing!=='CLASSIC'||!quote||quote.swapper?.toLowerCase()!==recipient.toLowerCase())fail('INVEST_CLASSIC_OWNER_ROUTE_REQUIRED')
  const hops=quote.route?.flat()
  if(!hops?.length||hops.length>8)fail('INVEST_ROUTE_REQUIRED')
  for(const hop of hops){
    const tokenIn=hop.tokenIn,tokenOut=hop.tokenOut
    if(![tokenIn,tokenOut].every(token=>Number(token?.chainId)===1301&&approvedTokens.includes(token.address?.toLowerCase())))fail('INVEST_ROUTE_TOKEN_DENIED')
    const id=(hop.address||hop.poolId||'').toLowerCase()
    if(!approvedPools.includes(id))fail('INVEST_ROUTE_POOL_DENIED')
  }
  return {hops:hops.length,expectedInput:quote.input?.amount,expectedOutput:quote.output?.amount,gasFee:quote.gasFee,priceImpact:quote.priceImpact,
    route:hops.map(h=>({pool:h.address||h.poolId,tokenIn:h.tokenIn.address,tokenOut:h.tokenOut.address,fee:h.fee}))}
}
