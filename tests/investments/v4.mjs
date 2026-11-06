import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {buildLp,lpApprovalCalls,readPool,positionTicks,feesOwed,positionAbi} from '../../backend/src/investments/v4.mjs'
import {createUniswapApi,approvedRoute} from '../../backend/src/investments/uniswap-api.mjs'
import {buildInvestmentPolicy} from '../../backend/src/investments/policy.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url))
const {decodeFunctionData,decodeAbiParameters,parseAbiParameters}=require('viem')
const address=n=>'0x'+n.repeat(40)
const manifest={chainId:1301,city:address('1'),usdc:address('2'),positionManager:address('3'),permit2:address('4'),poolManager:address('5'),pools:{cityUsdc:{currency0:address('1'),currency1:address('2'),fee:8388608,tickSpacing:60,hooks:address('6')}}}
const policy=buildInvestmentPolicy({...manifest,mode:'marketplace',router:address('8')},2000000000)
assert.equal(policy.rules.length,9)
for(const rule of policy.rules){assert.equal(rule.method,'eth_signTransaction');for(const c of rule.conditions.filter(c=>c.field_source==='ethereum_calldata'))assert(c.abi[0].inputs.some(p=>p.name===c.field.split('.')[1]))}
assert(policy.rules.every(r=>!r.conditions.some(c=>c.field==='to'&&c.value===address('9'))))
const tick=-276325,sqrt=(2n**96n)/1000000n
const fake={readContract:async()=>['0x'+(sqrt|(BigInt.asUintN(24,BigInt(tick))<<160n)).toString(16).padStart(64,'0'),'0x0','0x0','0x2386f26fc10000']}
const pool=await readPool(fake,manifest,1n)
const snapshot={pool},owner=address('7'),deadline=2000000000
const terms=buildLp(manifest,snapshot,{action:'deposit',amount0:'1000000000000000000',amount1:'1000000',tickLower:-276960,tickUpper:-275760},owner,deadline)
assert(BigInt(terms.liquidity)>0n)
assert(BigInt(terms.amounts[0])<=10n**18n);assert(BigInt(terms.amounts[1])<=10n**6n)
let call=decodeFunctionData({abi:positionAbi,data:terms.call.data})
assert.equal(call.functionName,'modifyLiquidities');assert.equal(call.args[1],BigInt(deadline))
let [actions,params]=decodeAbiParameters(parseAbiParameters('bytes,bytes[]'),call.args[0])
assert.equal(actions,'0x020d')
const mint=decodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'),params[0])
assert.equal(mint[6].toLowerCase(),owner);assert.deepEqual(mint.slice(4,6).map(String),terms.amounts)
assert.equal(lpApprovalCalls(manifest,terms).length,6)
assert.throws(()=>buildLp(manifest,snapshot,{action:'deposit',amount0:'10000000000000000001',amount1:'1000000',tickLower:-276960,tickUpper:-275760},owner,deadline),/INVEST_DEPOSIT_CAP/)
assert.throws(()=>buildLp(manifest,snapshot,{action:'deposit',amount0:'1',amount1:'1',tickLower:0,tickUpper:60},owner,deadline),/RANGE_NOT_ACTIVE/)
assert.throws(()=>buildLp(manifest,snapshot,{action:'deposit',slippageBps:101},owner,deadline),/SLIPPAGE_CAP/)
const position={liquidity:terms.liquidity,tickLower:terms.tickLower,tickUpper:terms.tickUpper,sdk:{token0PriceLower:{toSignificant:()=>'.9'},token0PriceUpper:{toSignificant:()=>'1.1'}}}
const withdraw=buildLp(manifest,{...snapshot,position},{action:'withdraw',tokenId:'42',withdrawBps:10000},owner,deadline)
call=decodeFunctionData({abi:positionAbi,data:withdraw.call.data});[actions,params]=decodeAbiParameters(parseAbiParameters('bytes,bytes[]'),call.args[0]);assert.equal(actions,'0x0111')
assert.equal(decodeAbiParameters(parseAbiParameters('address,address,address'),params[1])[2].toLowerCase(),owner)
assert.equal(lpApprovalCalls(manifest,withdraw).length,0)
const collect=buildLp(manifest,{...snapshot,position},{action:'collect',tokenId:'42'},owner,deadline)
assert.equal(collect.liquidity,'0');assert.deepEqual(collect.amounts,['0','0'])
assert.deepEqual(positionTicks(BigInt.asUintN(24,-276960n)<<8n|BigInt.asUintN(24,-275760n)<<32n),{tickLower:-276960,tickUpper:-275760})
const Q=1n<<128n
assert.deepEqual(feesOwed({liquidity:100n,tick:0,tickLower:-60,tickUpper:60,global:[4n*Q,5n*Q],outsideLower:[Q,Q],outsideUpper:[Q,Q],last:[Q,Q]}),[100n,200n])
assert.deepEqual(feesOwed({liquidity:100n,tick:-61,tickLower:-60,tickUpper:60,global:[0n,0n],outsideLower:[3n*Q,3n*Q],outsideUpper:[Q,Q],last:[Q,Q]}),[100n,100n])
let requests=[]
const api=createUniswapApi({key:'fixture-key',fetcher:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({chains:[]}))}})
await api.supportedChains();await api.poolInfo(manifest.pools.cityUsdc)
await assert.rejects(createUniswapApi({key:'fixture',fetcher:async()=>new Response(JSON.stringify({errorCode:'NoRouteFoundError'}),{status:404})}).supportedChains(),/INVEST_UNISWAP_NO_ROUTE/)
assert.equal(requests[0].options.redirect,'error');assert(requests[1].url.startsWith('https://liquidity.api.uniswap.org/lp/'))
assert.equal(JSON.parse(requests[1].options.body).chainId,1301)
const quote={routing:'CLASSIC',quote:{swapper:owner,route:[[{address:address('8'),tokenIn:{chainId:1301,address:manifest.city},tokenOut:{chainId:1301,address:manifest.usdc}}]]}}
assert.throws(()=>approvedRoute(quote,[],[manifest.city,manifest.usdc],owner),/POOL_DENIED/)
assert.equal(approvedRoute(quote,[address('8')],[manifest.city,manifest.usdc],owner).hops,1)
assert.throws(()=>approvedRoute(quote,[address('8')],[manifest.city,manifest.usdc],address('9')),/OWNER_ROUTE_REQUIRED/)
console.log('PASS investment v4 SDK math, bounded calls, recipient, fee growth, approvals and API route filtering (fixtures; zero public transactions)')
