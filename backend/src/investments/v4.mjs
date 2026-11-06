import {createRequire} from 'node:module'
import {encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, keccak256, encodePacked, toHex, formatUnits} from 'viem'

// The official SDK's CommonJS export works on Node; its ESM export has extensionless directory imports.
const require = createRequire(import.meta.url)
const {Pool, Position} = require('@uniswap/v4-sdk')
const {Token, Percent} = require('@uniswap/sdk-core')
export const tokenAbi = parseAbi(['function balanceOf(address account) view returns(uint256)', 'function allowance(address owner,address spender) view returns(uint256)', 'function approve(address spender,uint256 amount) returns(bool)'])
export const positionAbi = parseAbi([
  'function poolManager() view returns(address)', 'function permit2() view returns(address)',
  'function ownerOf(uint256) view returns(address)', 'function getPositionLiquidity(uint256) view returns(uint128)',
  'function getPoolAndPositionInfo(uint256) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable', 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'
])
export const permitAbi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)'])
const storageAbi = parseAbi(['function extsload(bytes32,uint256) view returns(bytes32[])'])
const keyType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const fail = code => {throw Object.assign(Error(code), {code})}
const lower = value => value.toLowerCase()
const mask = (1n << 256n) - 1n
const slot = (value, offset = 0n) => toHex((BigInt(value) + offset) & mask, {size:32})
const signedTick = value => Number(BigInt.asIntN(24, BigInt(value)))
export const poolId = key => keccak256(encodeAbiParameters(parseAbiParameters(keyType), [key]))
export const samePool = (a,b) => ['currency0','currency1','hooks'].every(k => lower(a[k]) === lower(b[k])) && Number(a.fee) === Number(b.fee) && Number(a.tickSpacing) === Number(b.tickSpacing)
export const positionTicks = info => ({tickLower:signedTick(BigInt(info) >> 8n), tickUpper:signedTick(BigInt(info) >> 32n)})
const wrap = value => value & mask
export function feesOwed({liquidity, tick, tickLower, tickUpper, global, outsideLower, outsideUpper, last}) {
  return global.map((g,i) => {
    const inside = tick < tickLower ? outsideLower[i]-outsideUpper[i] : tick >= tickUpper ? outsideUpper[i]-outsideLower[i] : g-outsideLower[i]-outsideUpper[i]
    return wrap(wrap(inside)-last[i]) * BigInt(liquidity) / (1n << 128n)
  })
}

/** Read offsets and fee arithmetic follow official v4-core 1.0.2 StateLibrary (MIT); see docs/THIRD_PARTY_INVESTMENTS.md. */
export async function readPool(client, manifest, blockNumber) {
  const key = manifest.pools.cityUsdc, id = poolId(key)
  const stateSlot = keccak256(encodePacked(['bytes32','bytes32'], [id,toHex(6,{size:32})]))
  const read = (start,n) => client.readContract({address:manifest.poolManager, abi:storageAbi, functionName:'extsload', args:[start,BigInt(n)], blockNumber})
  const words = (await read(stateSlot,4)).map(BigInt)
  const sqrtPriceX96 = words[0] & ((1n << 160n)-1n), tick = signedTick(words[0] >> 160n)
  const currency = address => new Token(1301,address,lower(address)===lower(manifest.usdc)?6:18,lower(address)===lower(manifest.usdc)?'tUSDC':'CITY')
  const sdk = new Pool(currency(key.currency0),currency(key.currency1),Number(key.fee),60,key.hooks,sqrtPriceX96.toString(),words[3].toString(),tick)
  return {key,id,stateSlot,read,tick,sqrtPriceX96,liquidity:words[3],global:words.slice(1,3),sdk}
}

export async function readPosition(client, manifest, tokenId, wallet, snapshot) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(tokenId))) fail('INVEST_POSITION_ID_REQUIRED')
  const at = {address:manifest.positionManager, abi:positionAbi, blockNumber:snapshot.blockNumber}
  const [owner,[key,info],liquidity] = await Promise.all([
    client.readContract({...at,functionName:'ownerOf',args:[BigInt(tokenId)]}),
    client.readContract({...at,functionName:'getPoolAndPositionInfo',args:[BigInt(tokenId)]}),
    client.readContract({...at,functionName:'getPositionLiquidity',args:[BigInt(tokenId)]})
  ])
  if(lower(owner)!==lower(wallet)) fail('INVEST_POSITION_OWNER_REQUIRED')
  if(!samePool(key,manifest.pools.cityUsdc)) fail('INVEST_POOL_NOT_APPROVED')
  const pool = snapshot.pool, ticks = positionTicks(info)
  const positionKey = keccak256(encodePacked(['address','int24','int24','bytes32'],[manifest.positionManager,ticks.tickLower,ticks.tickUpper,toHex(BigInt(tokenId),{size:32})]))
  const positionSlot = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32'),[positionKey,slot(pool.stateSlot,6n)]))
  const pos = (await pool.read(positionSlot,3)).map(BigInt)
  if(pos[0]!==liquidity) fail('INVEST_POSITION_LIQUIDITY_CHANGED')
  const outside = async tick => {
    const tickSlot = keccak256(encodeAbiParameters(parseAbiParameters('int24,bytes32'),[tick,slot(pool.stateSlot,4n)]))
    return (await pool.read(slot(tickSlot,1n),2)).map(BigInt)
  }
  const [outsideLower,outsideUpper] = await Promise.all([outside(ticks.tickLower),outside(ticks.tickUpper)])
  const fees = feesOwed({liquidity,tick:pool.tick,...ticks,global:pool.global,outsideLower,outsideUpper,last:pos.slice(1)})
  const sdk = new Position({pool:pool.sdk,liquidity:liquidity.toString(),...ticks})
  return {tokenId:String(tokenId),owner:lower(owner),liquidity:String(liquidity),...ticks,inRange:pool.tick>=ticks.tickLower&&pool.tick<ticks.tickUpper,
    principal:[sdk.amount0.quotient.toString(),sdk.amount1.quotient.toString()],fees:fees.map(String),sdk}
}

export function buildLp(manifest, snapshot, input, owner, deadline) {
  const pool = snapshot.pool, slippageBps = input.slippageBps ?? 50
  if(!Number.isSafeInteger(slippageBps)||slippageBps<1||slippageBps>100) fail('INVEST_SLIPPAGE_CAP')
  const tolerance = new Percent(slippageBps,10000), action = input.action
  let position = snapshot.position, amounts, liquidity, data, actions
  if(action==='deposit'||action==='increase') {
    const tickLower = action==='increase'?position?.tickLower:input.tickLower
    const tickUpper = action==='increase'?position?.tickUpper:input.tickUpper
    if(!Number.isSafeInteger(tickLower)||!Number.isSafeInteger(tickUpper)||tickLower%60||tickUpper%60||tickLower>=tickUpper||tickLower< -887220||tickUpper>887220) fail('INVEST_TICK_RANGE_REQUIRED')
    // Deposits require an in-range, two-sided range. Withdrawals remain possible outside the range.
    if(pool.tick<tickLower||pool.tick>=tickUpper) fail('INVEST_DEPOSIT_RANGE_NOT_ACTIVE')
    const requested = [input.amount0,input.amount1].map((v,i) => {
      if(!/^[1-9][0-9]{0,25}$/.test(String(v))) fail('INVEST_TOKEN_AMOUNT_REQUIRED')
      const max = lower(pool.key['currency'+i])===lower(manifest.usdc)?10n**7n:10n**19n
      if(BigInt(v)>max) fail('INVEST_DEPOSIT_CAP')
      return BigInt(v)
    })
    // Reserve the maximum, including SDK price slippage, inside the user's exact input caps.
    const desired = Position.fromAmounts({pool:pool.sdk,tickLower,tickUpper,amount0:requested[0].toString(),amount1:requested[1].toString(),useFullPrecision:true})
    const maxima=Object.values(desired.mintAmountsWithSlippage(tolerance)).map(v=>BigInt(v.toString()))
    const desiredLiquidity=BigInt(desired.liquidity.toString())
    const bounded=requested.map((v,i)=>maxima[i]>0n?desiredLiquidity*v/maxima[i]:desiredLiquidity)
    const p=new Position({pool:pool.sdk,tickLower,tickUpper,liquidity:(bounded.reduce((a,b)=>a<b?a:b,desiredLiquidity)).toString()})
    if(BigInt(p.liquidity.toString())===0n) fail('INVEST_LIQUIDITY_TOO_SMALL')
    amounts = Object.values(p.mintAmountsWithSlippage(tolerance)).map(v=>v.toString())
    if(amounts.some((v,i)=>BigInt(v)>requested[i]||BigInt(v)===0n)) fail('INVEST_INPUT_CAP_EXCEEDED')
    liquidity = p.liquidity.toString(); position=p
    if(action==='deposit') {actions='0x020d';data=encodeAbiParameters(parseAbiParameters(keyType+',int24,int24,uint256,uint128,uint128,address,bytes'),[pool.key,tickLower,tickUpper,BigInt(liquidity),...amounts.map(BigInt),owner,'0x'])}
    else {actions='0x000d';data=encodeAbiParameters(parseAbiParameters('uint256,uint256,uint128,uint128,bytes'),[BigInt(input.tokenId),BigInt(liquidity),...amounts.map(BigInt),'0x'])}
  } else if(action==='withdraw'||action==='collect') {
    if(!position) fail('INVEST_POSITION_REQUIRED')
    const bps = action==='collect'?0:input.withdrawBps
    if(!Number.isSafeInteger(bps)||bps<0||bps>10000||action==='withdraw'&&bps===0) fail('INVEST_WITHDRAW_FRACTION_REQUIRED')
    liquidity = (BigInt(position.liquidity)*BigInt(bps)/10000n).toString()
    if(action==='withdraw'&&liquidity==='0') fail('INVEST_LIQUIDITY_TOO_SMALL')
    const part = new Position({pool:pool.sdk,liquidity,...positionTicksFrom(position)})
    amounts = action==='collect'?['0','0']:Object.values(part.burnAmountsWithSlippage(tolerance)).map(v=>v.toString())
    actions='0x0111';data=encodeAbiParameters(parseAbiParameters('uint256,uint256,uint128,uint128,bytes'),[BigInt(input.tokenId),BigInt(liquidity),...amounts.map(BigInt),'0x'])
  } else fail('INVEST_ACTION_DENIED')
  const settlement = action==='deposit'||action==='increase'
    ? encodeAbiParameters(parseAbiParameters('address,address'),[pool.key.currency0,pool.key.currency1])
    : encodeAbiParameters(parseAbiParameters('address,address,address'),[pool.key.currency0,pool.key.currency1,owner])
  const unlock = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'),[actions,[data,settlement]])
  const call = {to:lower(manifest.positionManager),data:encodeFunctionData({abi:positionAbi,functionName:'modifyLiquidities',args:[unlock,BigInt(deadline)]}),value:'0'}
  return {action,tokenId:input.tokenId?String(input.tokenId):null,owner:lower(owner),liquidity,amounts,tickLower:position.tickLower,tickUpper:position.tickUpper,slippageBps,deadline:String(deadline),call,
    range:[position.token0PriceLower?.toSignificant(8)??position.sdk?.token0PriceLower.toSignificant(8),position.token0PriceUpper?.toSignificant(8)??position.sdk?.token0PriceUpper.toSignificant(8)]}
}
const positionTicksFrom = p => ({tickLower:p.tickLower,tickUpper:p.tickUpper})
export const displayAmounts = (key,manifest,amounts) => amounts.map((v,i)=>formatUnits(BigInt(v),lower(key['currency'+i])===lower(manifest.usdc)?6:18))

export function lpApprovalCalls(manifest, terms) {
  if(!['deposit','increase'].includes(terms.action)) return []
  return terms.amounts.flatMap((value,i) => {
    const token = manifest.pools.cityUsdc['currency'+i], amount=BigInt(value)
    return [
      {to:lower(token),data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[manifest.permit2,0n]}),value:'0'},
      {to:lower(token),data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[manifest.permit2,amount]}),value:'0'},
      {to:lower(manifest.permit2),data:encodeFunctionData({abi:permitAbi,functionName:'approve',args:[token,manifest.positionManager,amount,Number(terms.deadline)]}),value:'0'}
    ]
  })
}
