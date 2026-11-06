import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createPublicClient, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http,
  keccak256, parseAbi, parseEventLogs, parseUnits, stringToHex, zeroAddress } from 'viem'
import { foundry, unichainSepolia } from 'viem/chains'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_INPUT = (1n << 127n) - 1n
const inputLimit = row => BigInt(row.swap_kind === 'exact_output' ? row.maximum_in : row.amount_in)
const normalized = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const lower = address => getAddress(address).toLowerCase()
const uuid = value => { if (!UUID.test(value || '')) throw Error('MARKET_PLAYER_OR_OPERATION_REQUIRED'); return value.toLowerCase() }
const operation = (id, stage) => {
  const hex = digest([id, stage]).slice(0, 32)
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
}

export const MARKET_ABIS = Object.freeze({
  token: parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)',
    'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
    'event Approval(address indexed owner,address indexed spender,uint256 value)',
    'event Transfer(address indexed from,address indexed to,uint256 value)']),
  quoter: parseAbi(['function poolManager() view returns (address)',
    'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
    'function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountIn,uint256 gasEstimate)']),
  router: parseAbi(['function poolManager() view returns (address)',
    'function supportsExactOutput() pure returns (bool)',
    'function swapExactOutput(bytes32 operationId,bool zeroForOne,uint128 amountOut,uint128 maxAmountIn,uint48 deadline) returns (uint256 amountIn)',
    'function poolKey() view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
    'function swapExactInput(bytes32 operationId,bool zeroForOne,uint128 amountIn,uint128 minAmountOut,uint48 deadline) returns (uint256 amountOut)',
    'event SwapExecuted(bytes32 indexed operationId,address indexed trader,address indexed tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)']),
  manager: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'])
})

export function validateMarketManifest(input) {
  const manifest = structuredClone(input)
  const local = manifest?.environment === 'LOCAL_TEST_FIXTURE' && manifest.chainId === 31337 && manifest.rpcUrl === 'http://127.0.0.1:8559'
  const publicChain = manifest?.environment === 'UNICHAIN_SEPOLIA_PLAYABLE' && manifest.chainId === 1301 && manifest.rpcUrl === 'https://sepolia.unichain.org'
  const hooked=manifest?.schema==='agentcity.playable-market.v2'
  if ((!hooked && manifest?.schema !== 'agentcity.playable-market.v1') || (!local && !publicChain) || !/^0x[a-f0-9]{64}$/i.test(manifest.genesisHash || '')) throw Error('DEDICATED_TEST_MARKET_REQUIRED')
  if(hooked){
    manifest.hook=lower(manifest.hook);manifest.stateRegistry=lower(manifest.stateRegistry)
    if(manifest.hook===zeroAddress||manifest.stateRegistry===zeroAddress||!/^0x[a-f0-9]{64}$/i.test(manifest.marketId||''))throw Error('HOOKED_MARKET_BINDING_REQUIRED')
    for(const key of ['hook','stateRegistry'])if(!/^0x[a-f0-9]{64}$/i.test(manifest.codeHashes?.[key]||''))throw Error('HOOKED_MARKET_CODE_HASH_REQUIRED')
  }
  if (Object.keys(manifest.tokens || {}).sort().join(',') !== 'CITY,GEM') throw Error('CITY_GEM_ONLY')
  for (const symbol of ['CITY','GEM']) {
    manifest.tokens[symbol].address = lower(manifest.tokens[symbol].address)
    if (manifest.tokens[symbol].decimals !== 18) throw Error('MARKET_TOKEN_DECIMALS')
  }
  for (const key of ['poolManager','quoter','router']) manifest[key] = lower(manifest[key])
  const currencies = ['CITY','GEM'].map(symbol => manifest.tokens[symbol].address).sort()
  if (currencies[0] === currencies[1] || lower(manifest.poolKey?.currency0) !== currencies[0] || lower(manifest.poolKey?.currency1) !== currencies[1] ||
      manifest.poolKey.fee !== 3000 || manifest.poolKey.tickSpacing !== 60 || lower(manifest.poolKey.hooks) !== (hooked?manifest.hook:zeroAddress)) throw Error('FIXED_CITY_GEM_POOL_REQUIRED')
  manifest.poolKey = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60, hooks: hooked?manifest.hook:zeroAddress }
  const contracts=[...currencies,manifest.poolManager,manifest.quoter,manifest.router,...(hooked?[manifest.hook,manifest.stateRegistry]:[])]
  if (new Set(contracts).size !== contracts.length) throw Error('DISTINCT_MARKET_CONTRACTS_REQUIRED')
  for (const key of ['poolManager','quoter','router','CITY','GEM']) if (!/^0x[a-f0-9]{64}$/i.test(manifest.codeHashes?.[key] || '')) throw Error('MARKET_CODE_HASH_REQUIRED')
  if (manifest.exactOutputEnabled !== undefined && typeof manifest.exactOutputEnabled !== 'boolean') throw Error('MARKET_EXACT_OUTPUT_CAPABILITY_REQUIRED')
  const cap = BigInt(manifest.maxInputBaseUnits || '0')
  if (cap <= 0n || cap > 1000n * 10n ** 18n) throw Error('MARKET_INPUT_CAP_REQUIRED')
  manifest.confirmations = local ? 1 : 2
  manifest.maxGas = 1000000
  manifest.maxNativeCostWei = String(BigInt(manifest.maxNativeCostWei || '2000000000000000'))
  if (BigInt(manifest.maxNativeCostWei) <= 0n || BigInt(manifest.maxNativeCostWei) > 8000000000000000n) throw Error('MARKET_GAS_CAP_REQUIRED')
  return manifest
}

export async function createUniswapMarket({ pool, wallets, manifest: input, client: providedClient } = {}) {
  if (!pool?.query || !pool?.connect || !wallets?.getOrCreate || !wallets?.prepare || !wallets?.broadcast || !wallets?.reconcile) throw Error('MARKET_DURABLE_WALLETS_REQUIRED')
  const manifest = validateMarketManifest(input)
  const manifestDigest = digest(manifest)
  const chain = manifest.chainId === 31337 ? foundry : unichainSepolia
  const client = providedClient || createPublicClient({ chain, transport: http(manifest.rpcUrl, { retryCount: 0, timeout: 15000 }) })
  const instance = manifest.chainId + ':' + manifest.genesisHash.toLowerCase()
  const poolId = keccak256(encodeAbiParameters([{ type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}] }],[manifest.poolKey]))
  await pool.query(await readFile(new URL('./uniswap-market.sql', import.meta.url),'utf8'))

  async function verify() {
    if (await client.getChainId() !== manifest.chainId || (await client.getBlock({blockNumber:0n})).hash.toLowerCase() !== manifest.genesisHash.toLowerCase()) throw Error('MARKET_CHAIN_INSTANCE_CHANGED')
    for (const key of ['poolManager','quoter','router','CITY','GEM',...(manifest.schema==='agentcity.playable-market.v2'?['hook','stateRegistry']:[])]) {
      const address = manifest.tokens[key]?.address || manifest[key]
      const code = await client.getCode({address})
      if (!code || code === '0x' || keccak256(code).toLowerCase() !== manifest.codeHashes[key].toLowerCase()) throw Error('MARKET_CONTRACT_CODE_CHANGED:' + key)
    }
  }
  await verify()
  if(manifest.schema==='agentcity.playable-market.v2'){
    const hookAbi=parseAbi(['function poolManager() view returns(address)','function registry() view returns(address)','function currency0() view returns(address)','function currency1() view returns(address)'])
    for(const [method,expected] of [['poolManager',manifest.poolManager],['registry',manifest.stateRegistry],['currency0',manifest.poolKey.currency0],['currency1',manifest.poolKey.currency1]])
      if(lower(await client.readContract({address:manifest.hook,abi:hookAbi,functionName:method}))!==expected)throw Error('MARKET_HOOK_BINDING_CHANGED')
    if((await client.readContract({address:manifest.stateRegistry,abi:parseAbi(['function marketId() view returns(bytes32)']),functionName:'marketId'})).toLowerCase()!==manifest.marketId.toLowerCase())throw Error('MARKET_STATE_DOMAIN_CHANGED')
  }
  for (const symbol of ['CITY','GEM']) {
    const address = manifest.tokens[symbol].address
    if (await client.readContract({address,abi:MARKET_ABIS.token,functionName:'symbol'}) !== symbol || await client.readContract({address,abi:MARKET_ABIS.token,functionName:'decimals'}) !== 18) throw Error('MARKET_TOKEN_IDENTITY_CHANGED')
  }
  for (const [address,abi] of [[manifest.router,MARKET_ABIS.router],[manifest.quoter,MARKET_ABIS.quoter]]) if (lower(await client.readContract({address,abi,functionName:'poolManager'})) !== manifest.poolManager) throw Error('MARKET_MANAGER_BINDING_CHANGED')
  if (manifest.exactOutputEnabled && await client.readContract({address:manifest.router,abi:MARKET_ABIS.router,functionName:'supportsExactOutput'}) !== true) throw Error('MARKET_EXACT_OUTPUT_ROUTER_REQUIRED')
  const deployedKey = await client.readContract({address:manifest.router,abi:MARKET_ABIS.router,functionName:'poolKey'})
  if (lower(deployedKey[0]) !== manifest.poolKey.currency0 || lower(deployedKey[1]) !== manifest.poolKey.currency1 || deployedKey[2] !== 3000 || deployedKey[3] !== 60 || lower(deployedKey[4]) !== manifest.poolKey.hooks) throw Error('MARKET_ROUTER_POOL_CHANGED')

  const publicPreview = row => ({ previewId:row.preview_id,playerId:row.player_id,address:row.wallet_address,chainId:manifest.chainId,
    kind:row.swap_kind || 'exact_input',maxAmountInBaseUnits:String(inputLimit(row)),maxAmountIn:formatUnits(inputLimit(row),18),
    tokenIn:row.token_in,tokenOut:row.token_out,amountInBaseUnits:String(row.amount_in),quotedOutBaseUnits:String(row.quoted_out),minimumOutBaseUnits:String(row.minimum_out),
    amountIn:formatUnits(BigInt(row.amount_in),18),quotedOut:formatUnits(BigInt(row.quoted_out),18),minimumOut:formatUnits(BigInt(row.minimum_out),18),
    slippageBps:row.slippage_bps,deadline:Number(row.deadline),status:row.status,proof:row.proof,
    consented:Boolean(row.consent_at),confirmedAt:row.consent_at instanceof Date?row.consent_at.toISOString():row.consent_at,
    market:'Uniswap v4 fixed CITY/GEM test pool',gameCoinsCredited:false,realValueSupported:false })
  async function wallet(playerId) {
    const result = await wallets.getOrCreate(uuid(playerId))
    if (result.chainId !== manifest.chainId) throw Error('MARKET_WALLET_CHAIN_CHANGED')
    return { ...result,address:lower(result.address) }
  }
  async function owned(playerId, previewId, tx=pool) {
    const row = (await tx.query('SELECT * FROM ac_playable_market_previews WHERE preview_id=$1 AND player_id=$2',[uuid(previewId),uuid(playerId)])).rows[0]
    if (!row) throw Error('MARKET_PREVIEW_OWNER_REQUIRED')
    if (row.chain_instance !== instance || row.manifest_digest !== manifestDigest) throw Error('MARKET_PREVIEW_DEPLOYMENT_CHANGED')
    return row
  }
  async function update(tx,row,status,proof=row.proof) {
    return (await tx.query('UPDATE ac_playable_market_previews SET status=$2,proof=$3,updated_at=now() WHERE preview_id=$1 RETURNING *',[row.preview_id,status,normalized(proof)])).rows[0]
  }
  async function existing(playerId, operationId) {
    try { return await wallets.reconcile({playerId,operationId}) }
    catch(error) { if (['TESTNET_INTENT_OWNER_REQUIRED','unknown_transaction_intent'].includes(error.message)) return null; throw error }
  }
  async function originalTransaction(playerId, operationId, to, data) {
    await wallets.prepare({playerId,operationId,to,data,value:0n,limits:{maxGas:manifest.maxGas,maxNativeCostWei:manifest.maxNativeCostWei}})
    await wallets.broadcast({playerId,operationId})
    return wallets.reconcile({playerId,operationId})
  }
  async function canonical(result, expectedTo, expectedData, ownerAddress) {
    const transactionHash = result.hash || result.transactionHash
    if (!/^0x[a-f0-9]{64}$/i.test(transactionHash || '')) throw Error('MARKET_TRANSACTION_HASH_REQUIRED')
    if (!['confirmed','reverted'].includes(result.status)) return {status:result.status,transactionHash}
    const receipt = await client.getTransactionReceipt({hash:transactionHash})
    const block = await client.getBlock({blockNumber:receipt.blockNumber})
    if (block.hash !== receipt.blockHash || (await client.getBlockNumber({cacheTime:0}))-receipt.blockNumber+1n<BigInt(manifest.confirmations)) return {status:'reconciliation_required',transactionHash}
    const transaction = await client.getTransaction({hash:transactionHash})
    if (lower(transaction.from) !== ownerAddress || lower(transaction.to) !== lower(expectedTo) || transaction.input.toLowerCase() !== expectedData.toLowerCase() || transaction.value !== 0n) throw Error('MARKET_CANONICAL_TRANSACTION_CHANGED')
    if (receipt.status !== 'success') return {status:'reverted',transactionHash,receipt}
    return {status:'confirmed',transactionHash,receipt}
  }
  function swapData(row) {
    const exactOutput = row.swap_kind === 'exact_output'
    return encodeFunctionData({abi:MARKET_ABIS.router,functionName:exactOutput?'swapExactOutput':'swapExactInput',args:[row.operation_key,
      manifest.tokens[row.token_in].address===manifest.poolKey.currency0,
      BigInt(exactOutput?row.quoted_out:row.amount_in),exactOutput?inputLimit(row):BigInt(row.minimum_out),Number(row.deadline)]})
  }
  async function swapProof(row,result) {
    const observed = await canonical(result,manifest.router,swapData(row),row.wallet_address)
    if (observed.status !== 'confirmed') return observed
    const receipt = observed.receipt
    const executed = parseEventLogs({abi:MARKET_ABIS.router,eventName:'SwapExecuted',logs:receipt.logs,strict:true})
      .filter(log=>lower(log.address)===manifest.router)
    if (executed.length!==1) throw Error('MARKET_SWAP_EVENT_REQUIRED')
    const event = executed[0].args
    const amountsMatch = row.swap_kind === 'exact_output'
      ? event.amountIn > 0n && event.amountIn <= inputLimit(row) && event.amountOut === BigInt(row.quoted_out)
      : event.amountIn === BigInt(row.amount_in) && event.amountOut >= BigInt(row.minimum_out)
    if (event.operationId!==row.operation_key || lower(event.trader)!==row.wallet_address || lower(event.tokenIn)!==manifest.tokens[row.token_in].address || lower(event.tokenOut)!==manifest.tokens[row.token_out].address || !amountsMatch) throw Error('MARKET_SWAP_EVENT_BINDING_CHANGED')
    const swaps = parseEventLogs({abi:MARKET_ABIS.manager,eventName:'Swap',logs:receipt.logs,strict:true})
      .filter(log=>lower(log.address)===manifest.poolManager&&log.args.id===poolId&&lower(log.args.sender)===manifest.router)
    if (swaps.length!==1 || swaps[0].args.fee!==3000) throw Error('OFFICIAL_V4_SWAP_EVENT_REQUIRED')
    const zeroForOne=manifest.tokens[row.token_in].address===manifest.poolKey.currency0
    if ((zeroForOne?swaps[0].args.amount0:swaps[0].args.amount1)!==-event.amountIn ||
        (zeroForOne?swaps[0].args.amount1:swaps[0].args.amount0)!==event.amountOut) throw Error('OFFICIAL_V4_SWAP_AMOUNTS_CHANGED')
    const transfers=parseEventLogs({abi:MARKET_ABIS.token,eventName:'Transfer',logs:receipt.logs,strict:true})
    const transferred=(token,from,to)=>transfers.filter(log=>lower(log.address)===token&&lower(log.args.from)===from&&lower(log.args.to)===to).reduce((total,log)=>total+log.args.value,0n)
    if (transferred(manifest.tokens[row.token_in].address,row.wallet_address,manifest.poolManager)!==event.amountIn || transferred(manifest.tokens[row.token_out].address,manifest.poolManager,row.wallet_address)!==event.amountOut) throw Error('MARKET_TOKEN_RECEIPTS_REQUIRED')
    return {status:'confirmed',transactionHash:observed.transactionHash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,
      amountInBaseUnits:String(event.amountIn),amountOutBaseUnits:String(event.amountOut),poolId,gameCoinsCredited:false}
  }

  async function preview(input) {
    const fields = ['playerId','operationId','tokenIn','tokenOut','amountIn','amountOut','maxAmountIn','slippageBps','ttlSeconds']
    if (!input || Object.keys(input).some(key => !fields.includes(key))) throw Error('MARKET_PREVIEW_FIELDS')
    const playerId = uuid(input.playerId), id = uuid(input.operationId)
    const tokenIn = String(input.tokenIn || '').toUpperCase(), tokenOut = String(input.tokenOut || '').toUpperCase()
    if (!['CITY','GEM'].includes(tokenIn) || !['CITY','GEM'].includes(tokenOut) || tokenIn === tokenOut) throw Error('CITY_GEM_ONLY')
    const exactInput = input.amountIn !== undefined, exactOutput = input.amountOut !== undefined
    if (exactInput === exactOutput || exactInput && input.maxAmountIn !== undefined) throw Error('MARKET_EXACT_AMOUNT_REQUIRED')
    const amount = exactOutput ? input.amountOut : input.amountIn
    const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)
    if (!decimal(amount) || input.maxAmountIn !== undefined && !decimal(input.maxAmountIn)) throw Error('MARKET_DECIMAL_AMOUNT_REQUIRED')
    const specified = parseUnits(amount,18), slippageBps = input.slippageBps ?? 100, ttl = input.ttlSeconds ?? 60
    const requestedMaximum = input.maxAmountIn === undefined ? null : parseUnits(input.maxAmountIn,18)
    const cap = BigInt(manifest.maxInputBaseUnits)
    if (specified <= 0n || specified > MAX_INPUT || exactInput && specified > cap) throw Error('MARKET_AMOUNT_SLIPPAGE_OR_DEADLINE')
    if (requestedMaximum !== null && (requestedMaximum <= 0n || requestedMaximum > cap)) throw Error('MARKET_AMOUNT_SLIPPAGE_OR_DEADLINE')
    if (!Number.isSafeInteger(slippageBps) || slippageBps < 10 || slippageBps > 500 || !Number.isSafeInteger(ttl) || ttl < 30 || ttl > 120) throw Error('MARKET_AMOUNT_SLIPPAGE_OR_DEADLINE')
    if (exactOutput && !manifest.exactOutputEnabled) throw Error('MARKET_EXACT_OUTPUT_NOT_DEPLOYED')
    // Keep old fingerprints usable so an upgrade can still reconcile exact-input intents.
    const fingerprint = digest(exactOutput
      ? ['exact_output',playerId,tokenIn,tokenOut,String(specified),requestedMaximum === null ? null : String(requestedMaximum),slippageBps,ttl,manifestDigest]
      : [playerId,tokenIn,tokenOut,String(specified),slippageBps,ttl,manifestDigest])
    const previous = (await pool.query('SELECT * FROM ac_playable_market_previews WHERE request_operation_id=$1',[id])).rows[0]
    if (previous) {
      if (previous.player_id !== playerId || previous.request_digest !== fingerprint) throw Error('MARKET_OPERATION_BINDING_CHANGED')
      return publicPreview(await owned(playerId,previous.preview_id))
    }
    await verify()
    const account = await wallet(playerId), block = await client.getBlock({blockTag:'latest'})
    const quote = await client.simulateContract({address:manifest.quoter,abi:MARKET_ABIS.quoter,
      functionName:exactOutput ? 'quoteExactOutputSingle' : 'quoteExactInputSingle',account:account.address,blockNumber:block.number,
      args:[{poolKey:manifest.poolKey,zeroForOne:manifest.tokens[tokenIn].address === manifest.poolKey.currency0,exactAmount:specified,hookData:'0x'}]})
    const amountIn = exactOutput ? quote.result[0] : specified, amountOut = exactOutput ? specified : quote.result[0]
    const minimum = exactOutput ? amountOut : amountOut * BigInt(10000-slippageBps) / 10000n
    let maximum = null
    if (exactOutput) {
      // Round up to whole wei, then narrow the quote to both the operator and owner's caps.
      maximum = (amountIn * BigInt(10000+slippageBps) + 9999n) / 10000n
      if (maximum > cap) maximum = cap
      if (requestedMaximum !== null && maximum > requestedMaximum) maximum = requestedMaximum
      if (amountIn <= 0n || maximum < amountIn) throw Error('MARKET_MAXIMUM_INPUT_TOO_LOW')
    }
    if (minimum <= 0n || minimum > MAX_INPUT) throw Error('MARKET_QUOTE_UNUSABLE')
    const approvalId = operation(id,'approve'), swapId = operation(id,'swap'), operationKey = keccak256(stringToHex(id))
    await pool.query(`INSERT INTO ac_playable_market_previews(preview_id,player_id,request_operation_id,request_digest,chain_instance,manifest_digest,wallet_address,token_in,token_out,amount_in,quoted_out,minimum_out,slippage_bps,deadline,quote_block_number,quote_block_hash,approval_operation_id,swap_operation_id,operation_key,swap_kind,maximum_in)
      VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(request_operation_id) DO NOTHING`,
      [id,playerId,fingerprint,instance,manifestDigest,account.address,tokenIn,tokenOut,String(amountIn),String(amountOut),String(minimum),slippageBps,String(block.timestamp+BigInt(ttl)),String(block.number),block.hash,approvalId,swapId,operationKey,exactOutput ? 'exact_output' : 'exact_input',maximum === null ? null : String(maximum)])
    const saved = await owned(playerId,id)
    if (saved.request_digest !== fingerprint) throw Error('MARKET_OPERATION_BINDING_CHANGED')
    return publicPreview(saved)
  }

  async function execute({playerId:player,previewId},explicitConfirmation) {
    const playerId=uuid(player)
    const tx=await pool.connect()
    try {
      await tx.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['playable-market:'+playerId])
      let row=await owned(playerId,previewId,tx)
      // Retry and agent preview polling can never create the owner's consent.
      if(!explicitConfirmation&&!row.consent_at)return publicPreview(row)
      if(explicitConfirmation&&!row.consent_at) row=(await tx.query('UPDATE ac_playable_market_previews SET consent_at=clock_timestamp(),consent_player_id=$2,updated_at=now() WHERE preview_id=$1 RETURNING *',[row.preview_id,playerId])).rows[0]
      await verify()
      if((await wallet(playerId)).address!==row.wallet_address)throw Error('MARKET_WALLET_CHANGED')
      const conflicting=(await tx.query("SELECT preview_id FROM ac_playable_market_previews WHERE player_id=$1 AND preview_id<>$2 AND chain_instance=$3 AND status IN ('approving','approved','swapping','reconciliation_required') LIMIT 1",[playerId,row.preview_id,instance])).rows[0]
      if(conflicting)throw Error('PRIOR_SWAP_RECONCILIATION_REQUIRED:'+conflicting.preview_id)
      const priorSwap=await existing(playerId,row.swap_operation_id)
      let now=(await client.getBlock({blockTag:'latest'})).timestamp
      if(priorSwap) {
        if(['confirmed','reverted','reorganized'].includes(priorSwap.status)) {
          const proof=await swapProof(row,priorSwap)
          row=await update(tx,row,proof.status==='confirmed'?'confirmed':proof.status==='reverted'?'reverted':'reconciliation_required',{...row.proof,swap:proof})
          return publicPreview(row)
        }
        if(now>=BigInt(row.deadline)){row=await update(tx,row,'reconciliation_required',{...row.proof,reason:'expired_signed_swap_requires_original_intent_review'});return publicPreview(row)}
      } else if(['confirmed','reverted'].includes(row.status)) throw Error('MARKET_SETTLED_INTENT_MISSING')
      if(['expired'].includes(row.status))return publicPreview(row)
      const approvalData=encodeFunctionData({abi:MARKET_ABIS.token,functionName:'approve',args:[manifest.router,inputLimit(row)]})
      if(!priorSwap) {
        const priorApproval=await existing(playerId,row.approval_operation_id)
        if(now>=BigInt(row.deadline)&&priorApproval&&!['confirmed','reverted'].includes(priorApproval.status)) {
          row=await update(tx,row,'reconciliation_required',{...row.proof,reason:'expired_approval_requires_original_intent_review'});return publicPreview(row)
        }
        if(now>=BigInt(row.deadline)) {row=await update(tx,row,'expired');return publicPreview(row)}
        if((await client.getBlock({blockNumber:BigInt(row.quote_block_number)})).hash!==row.quote_block_hash)throw Error('MARKET_QUOTE_REORGANIZED')
        const balance=await client.readContract({address:manifest.tokens[row.token_in].address,abi:MARKET_ABIS.token,functionName:'balanceOf',args:[row.wallet_address]})
        if(balance<inputLimit(row))throw Error('MARKET_INPUT_BALANCE_INSUFFICIENT')
        const allowance=await client.readContract({address:manifest.tokens[row.token_in].address,abi:MARKET_ABIS.token,functionName:'allowance',args:[row.wallet_address,manifest.router]})
        if(priorApproval||allowance<inputLimit(row)) {
          row=await update(tx,row,'approving')
          const result=await originalTransaction(playerId,row.approval_operation_id,manifest.tokens[row.token_in].address,approvalData)
          const receipt=await canonical(result,manifest.tokens[row.token_in].address,approvalData,row.wallet_address)
          if(receipt.status!=='confirmed') {row=await update(tx,row,receipt.status==='reverted'?'reverted':'approving',{...row.proof,approval:{status:receipt.status,transactionHash:receipt.transactionHash}});return publicPreview(row)}
          const approvals=parseEventLogs({abi:MARKET_ABIS.token,eventName:'Approval',logs:receipt.receipt.logs,strict:true}).filter(log=>lower(log.address)===manifest.tokens[row.token_in].address&&lower(log.args.owner)===row.wallet_address&&lower(log.args.spender)===manifest.router&&log.args.value===inputLimit(row))
          if(approvals.length!==1)throw Error('MARKET_APPROVAL_EVENT_REQUIRED')
          row=await update(tx,row,'approved',{...row.proof,approval:{status:'confirmed',transactionHash:receipt.transactionHash}})
        }
        now=(await client.getBlock({blockTag:'latest'})).timestamp
        if(now>=BigInt(row.deadline)){row=await update(tx,row,'expired');return publicPreview(row)}
      }
      row=await update(tx,row,'swapping')
      const result=await originalTransaction(playerId,row.swap_operation_id,manifest.router,swapData(row))
      const proof=await swapProof(row,result)
      row=await update(tx,row,proof.status==='confirmed'?'confirmed':proof.status==='reverted'?'reverted':'swapping',{...row.proof,swap:proof})
      return publicPreview(row)
    } finally {
      try {await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['playable-market:'+playerId])}finally{tx.release()}
    }
  }

  return {preview,confirm:input=>execute(input,true),retry:input=>execute(input,false),
    getPreview:async({playerId,previewId})=>publicPreview(await owned(playerId,previewId)),manifest:structuredClone(manifest),
    balances:async({playerId})=>{await verify();const account=await wallet(playerId);const balances={};for(const symbol of ['CITY','GEM']){const amount=await client.readContract({address:manifest.tokens[symbol].address,abi:MARKET_ABIS.token,functionName:'balanceOf',args:[account.address]});balances[symbol]={baseUnits:String(amount),amount:formatUnits(amount,18)}}return {address:account.address,chainId:manifest.chainId,nativeBalanceWei:String(await client.getBalance({address:account.address})),tokens:balances,gameCoinsCredited:false}},
    history:async({playerId})=>(await pool.query('SELECT * FROM ac_playable_market_previews WHERE player_id=$1 AND chain_instance=$2 ORDER BY created_at DESC LIMIT 20',[uuid(playerId),instance])).rows.map(publicPreview)}
}
