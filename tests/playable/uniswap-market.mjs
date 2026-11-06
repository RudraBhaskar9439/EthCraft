// Real dedicated Anvil integration. No public funding, old market or game mutation.
import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { readFile,mkdir,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { createUniswapMarket,MARKET_ABIS } from '../../backend/src/playable/uniswap-market.mjs'
import { createTestnetWallets } from '../../backend/src/playable/testnet-wallets.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url))
const {createPublicClient,createWalletClient,http,encodeFunctionData,parseUnits}=require('viem')
const {foundry}=require('viem/chains')
const {privateKeyToAccount,generatePrivateKey}=require('viem/accounts')
const root=fileURLToPath(new URL('../../',import.meta.url))
const runId=randomUUID(),schema='market_test_'+runId.replaceAll('-','')
const evidence=join(root,'evidence/runs/playable-uniswap',runId)
await mkdir(evidence,{recursive:true})
const report={status:'fail',kind:'actual_local_uniswap_v4_market',runId,schema,publicTransactions:0,realSpending:0,
  gameCoinsCredited:false,independentHumansVerified:0,scope:'Dedicated8559CITY/GEMtestpool; no old8547market, Minecraft, custody backing or humanwalletsignoff claim',checks:[]}
const check=(name,details={})=>{report.checks.push({name,status:'pass',...details});console.log(JSON.stringify({check:name,status:'pass',...details}))}
let administrator,pool
try{
  if(process.platform==='win32')throw Error('Run under WSL for Unix-private managed wallet keystores.')
  const manifest=JSON.parse(await readFile(join(root,'.local/playable-market/deployment.json'),'utf8'))
  assert.equal(manifest.environment,'LOCAL_TEST_FIXTURE');assert.equal(manifest.rpcUrl,'http://127.0.0.1:8559')
  report.manifest=manifest
  const client=createPublicClient({chain:foundry,transport:http(manifest.rpcUrl,{retryCount:0,timeout:15000})})
  assert.equal((await client.getBlock({blockNumber:0n})).hash,manifest.genesisHash)
  const sender=createWalletClient({chain:foundry,transport:http(manifest.rpcUrl,{retryCount:0,timeout:15000})})
  const settings=JSON.parse(await readFile(join(root,'.local/backend/environment.json'),'utf8'))
  administrator=new pg.Pool({connectionString:settings.databaseUrl,max:1})
  await administrator.query('CREATE SCHEMA '+schema)
  const database=new URL(settings.databaseUrl);database.searchParams.set('options','-c search_path='+schema)
  pool=new pg.Pool({connectionString:database.href,max:6})
  const fixtureAccounts=new Map();let signatures=0
  const provider={kind:'local_fixture',ensureWallet:async({externalId})=>{
    if(!fixtureAccounts.has(externalId))fixtureAccounts.set(externalId,privateKeyToAccount(generatePrivateKey()))
    const account=fixtureAccounts.get(externalId)
    return{address:account.address.toLowerCase(),accountId:'fixture-'+externalId,externalId}
  },signTransaction:async({externalId,transaction,operationId})=>{
    signatures++
    const account=fixtureAccounts.get(externalId)
    return{rawTransaction:await account.signTransaction({...transaction,gas:BigInt(transaction.gas),maxFeePerGas:BigInt(transaction.maxFeePerGas),maxPriorityFeePerGas:BigInt(transaction.maxPriorityFeePerGas),value:BigInt(transaction.value)}),reference:operationId}
  }}
  const wallets=await createTestnetWallets({pool,rootDirectory:root,provider,environment:manifest.environment,chainId:manifest.chainId,
    rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,allowBroadcast:true,
    allowedTargets:[manifest.router,...Object.values(manifest.tokens).map(token=>token.address)]})
  const playerId=randomUUID(),stranger=randomUUID()
  const account=await wallets.getOrCreate(playerId)
  report.playerFixture={playerId,address:account.address,custody:account.custody}
  const funding=[]
  funding.push(await sender.sendTransaction({account:manifest.localFixture.administrator,to:account.address,value:parseUnits('0.01',18)}))
  for(const symbol of['CITY','GEM'])funding.push(await sender.sendTransaction({account:manifest.localFixture.administrator,to:manifest.tokens[symbol].address,
    data:encodeFunctionData({abi:MARKET_ABIS.token,functionName:'transfer',args:[account.address,parseUnits('100',18)]})}))
  for(const hash of funding)assert.equal((await client.waitForTransactionReceipt({hash})).status,'success')
  report.fundingTransactions=funding
  const market=await createUniswapMarket({pool,wallets,manifest})
  const before=await market.balances({playerId})
  assert.equal(before.tokens.CITY.baseUnits,String(parseUnits('100',18)))
  assert.equal(before.tokens.GEM.baseUnits,String(parseUnits('100',18)))
  check('actual-new-v4-pool-code-roles-and-funded-disposable-wallet',{chainId:manifest.chainId})
  const id=randomUUID()
  const preview=await market.preview({playerId,operationId:id,tokenIn:'CITY',tokenOut:'GEM',amountIn:'10',slippageBps:100,ttlSeconds:120})
  assert.equal(preview.status,'preview');assert.ok(BigInt(preview.quotedOutBaseUnits)>0n)
  assert.equal(preview.consented,false)
  assert.equal((await market.getPreview({playerId,previewId:id})).consented,false)
  assert.equal((await market.retry({playerId,previewId:id})).consented,false)
  assert.equal(signatures,0,'Polling or retry of an unconfirmed preview must never sign')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count,0)
  assert.equal((await market.preview({playerId,operationId:id,tokenIn:'CITY',tokenOut:'GEM',amountIn:'10',slippageBps:100,ttlSeconds:120})).previewId,id)
  await assert.rejects(market.preview({playerId,operationId:id,tokenIn:'CITY',tokenOut:'GEM',amountIn:'11',slippageBps:100,ttlSeconds:120}),/BINDING_CHANGED/)
  await assert.rejects(market.confirm({playerId:stranger,previewId:id}),/OWNER_REQUIRED/)
  await assert.rejects(market.preview({playerId,operationId:randomUUID(),tokenIn:'KIT',tokenOut:'CITY',amountIn:'1'}),/CITY_GEM_ONLY/)
  await assert.rejects(market.preview({playerId,operationId:randomUUID(),tokenIn:'CITY',tokenOut:'GEM',amountIn:'1',slippageBps:0}),/SLIPPAGE/)
  check('strict-owner-bound-quote-preview-never-signs-or-sends',{quotedOut:preview.quotedOut,minimumOut:preview.minimumOut})
  let result=await market.confirm({playerId,previewId:id})
  for(let i=0;i<10&&!['confirmed','reverted','reconciliation_required'].includes(result.status);i++){
    await new Promise(resolve=>setTimeout(resolve,200));result=await market.retry({playerId,previewId:id})
  }
  assert.equal(result.status,'confirmed',JSON.stringify(result))
  const after=await market.balances({playerId})
  assert.equal(BigInt(before.tokens.CITY.baseUnits)-BigInt(after.tokens.CITY.baseUnits),parseUnits('10',18))
  assert.equal(BigInt(after.tokens.GEM.baseUnits)-BigInt(before.tokens.GEM.baseUnits),BigInt(result.proof.swap.amountOutBaseUnits))
  assert.ok(BigInt(result.proof.swap.amountOutBaseUnits)>=BigInt(preview.minimumOutBaseUnits))
  check('actual-erc20-approval-v4-exact-input-and-canonical-event-transfer-proof',{transactionHash:result.proof.swap.transactionHash,amountOutBaseUnits:result.proof.swap.amountOutBaseUnits})
  const count=(await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count
  const nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'})
  assert.equal((await market.retry({playerId,previewId:id})).status,'confirmed')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count,count)
  assert.equal(await client.getTransactionCount({address:account.address,blockTag:'pending'}),nonce)
  assert.deepEqual((await market.balances({playerId})).tokens,after.tokens)
  check('same-preview-replay-reuses-original-purchase-and-pays-zero-extra')
  const reverse=await market.preview({playerId,operationId:randomUUID(),tokenIn:'GEM',tokenOut:'CITY',amountIn:'5',slippageBps:100,ttlSeconds:120})
  let reverseResult=await market.confirm({playerId,previewId:reverse.previewId})
  for(let i=0;i<10&&reverseResult.status!=='confirmed';i++){await new Promise(resolve=>setTimeout(resolve,200));reverseResult=await market.retry({playerId,previewId:reverse.previewId})}
  assert.equal(reverseResult.status,'confirmed',JSON.stringify(reverseResult))
  check('actual-reverse-GEM-to-CITY-swap',{transactionHash:reverseResult.proof.swap.transactionHash})
  // Recreate the previous table shape, then migrate it with an outstanding input quote.
  const legacyManifest = structuredClone(manifest)
  delete legacyManifest.exactOutputEnabled
  const legacyMarket = await createUniswapMarket({pool,wallets,manifest:legacyManifest})
  await assert.rejects(legacyMarket.preview({playerId,operationId:randomUUID(),tokenIn:'GEM',tokenOut:'CITY',amountOut:'1'}),/EXACT_OUTPUT_NOT_DEPLOYED/)
  const legacy = await legacyMarket.preview({playerId,operationId:randomUUID(),tokenIn:'GEM',tokenOut:'CITY',amountIn:'0.1',ttlSeconds:120})
  await pool.query('ALTER TABLE ac_playable_market_previews DROP COLUMN swap_kind')
  await pool.query('ALTER TABLE ac_playable_market_previews DROP COLUMN maximum_in')
  const migrated = await createUniswapMarket({pool,wallets,manifest:legacyManifest})
  const restoredLegacy = await migrated.getPreview({playerId,previewId:legacy.previewId})
  assert.equal(restoredLegacy.amountInBaseUnits,legacy.amountInBaseUnits)
  assert.equal(restoredLegacy.minimumOutBaseUnits,legacy.minimumOutBaseUnits)
  assert.equal(restoredLegacy.deadline,legacy.deadline)
  let legacyResult = await migrated.confirm({playerId,previewId:legacy.previewId})
  for(let i=0;i<10&&legacyResult.status!=='confirmed';i++) {
    await new Promise(resolve=>setTimeout(resolve,200))
    legacyResult=await migrated.retry({playerId,previewId:legacy.previewId})
  }
  assert.equal(legacyResult.status,'confirmed')
  check('existing-exact-input-quote-survives-actual-column-migration-and-confirmation',{transactionHash:legacyResult.proof.swap.transactionHash})

  const outputId = randomUUID(), signaturesBeforePreview = signatures
  const outputRequest = {playerId,operationId:outputId,tokenIn:'GEM',tokenOut:'CITY',amountOut:'3',maxAmountIn:'5',slippageBps:100,ttlSeconds:120}
  const output = await market.preview(outputRequest)
  assert.equal(output.kind,'exact_output')
  assert.equal(output.quotedOutBaseUnits,String(parseUnits('3',18)))
  assert.equal(output.minimumOutBaseUnits,output.quotedOutBaseUnits)
  assert(BigInt(output.maxAmountInBaseUnits)>=BigInt(output.amountInBaseUnits))
  assert(BigInt(output.maxAmountInBaseUnits)<=parseUnits('5',18))
  await market.retry({playerId,previewId:outputId})
  await assert.rejects(market.confirm({playerId:stranger,previewId:outputId}),/OWNER_REQUIRED/)
  await assert.rejects(market.preview({...outputRequest,maxAmountIn:'4'}),/BINDING_CHANGED/)
  await assert.rejects(market.preview({...outputRequest,operationId:randomUUID(),maxAmountIn:'0.000000000000000001'}),/MAXIMUM_INPUT_TOO_LOW/)
  await assert.rejects(market.preview({...outputRequest,operationId:randomUUID(),amountIn:'1'}),/EXACT_AMOUNT_REQUIRED/)
  await assert.rejects(pool.query('UPDATE ac_playable_market_previews SET maximum_in=maximum_in+1 WHERE preview_id=$1',[outputId]),/PLAYABLE_MARKET_PREVIEW_IMMUTABLE/)
  assert.equal(signatures,signaturesBeforePreview)
  check('exact-output-owner-quote-and-spend-cap-are-immutable-and-never-sign-before-confirmation',{target:output.quotedOut,maximumInput:output.maxAmountIn})

  const outputRow=(await pool.query('SELECT * FROM ac_playable_market_previews WHERE preview_id=$1',[outputId])).rows[0]
  let lostReply=false
  const interruptedWallets={...wallets,broadcast:async request=>{
    const sent=await wallets.broadcast(request)
    if(request.operationId===outputRow.swap_operation_id&&!lostReply){lostReply=true;throw Error('fixture_lost_exact_output_reply')}
    return sent
  }}
  const interrupted=await createUniswapMarket({pool,wallets:interruptedWallets,manifest})
  const beforeOutput=await market.balances({playerId})
  try { await interrupted.confirm({playerId,previewId:outputId}) }
  catch(error){assert.equal(error.message,'fixture_lost_exact_output_reply')}
  for(let i=0;i<10&&!lostReply;i++) {
    await new Promise(resolve=>setTimeout(resolve,200))
    try { await interrupted.retry({playerId,previewId:outputId}) }
    catch(error){assert.equal(error.message,'fixture_lost_exact_output_reply')}
  }
  assert.equal(lostReply,true)
  const restarted=await createUniswapMarket({pool,wallets,manifest})
  assert.equal((await restarted.getPreview({playerId,previewId:outputId})).maxAmountInBaseUnits,output.maxAmountInBaseUnits)
  let outputResult=await restarted.retry({playerId,previewId:outputId})
  for(let i=0;i<10&&outputResult.status!=='confirmed';i++) {
    await new Promise(resolve=>setTimeout(resolve,200))
    outputResult=await restarted.retry({playerId,previewId:outputId})
  }
  assert.equal(outputResult.status,'confirmed',JSON.stringify(outputResult))
  const afterOutput=await market.balances({playerId}),spent=BigInt(outputResult.proof.swap.amountInBaseUnits)
  assert(spent>0n&&spent<=BigInt(output.maxAmountInBaseUnits))
  assert.equal(BigInt(beforeOutput.tokens.GEM.baseUnits)-BigInt(afterOutput.tokens.GEM.baseUnits),spent)
  assert.equal(BigInt(afterOutput.tokens.CITY.baseUnits)-BigInt(beforeOutput.tokens.CITY.baseUnits),parseUnits('3',18))
  assert.equal(outputResult.proof.swap.amountOutBaseUnits,String(parseUnits('3',18)))
  assert.equal(await client.readContract({address:manifest.tokens.GEM.address,abi:MARKET_ABIS.token,functionName:'allowance',args:[account.address,manifest.router]}),BigInt(output.maxAmountInBaseUnits)-spent)
  check('exact-output-lost-reply-and-service-recreation-recover-real-v4-swap-within-original-cap',{transactionHash:outputResult.proof.swap.transactionHash,actualInput:String(spent),actualOutput:outputResult.proof.swap.amountOutBaseUnits})
  const settledNonce=await client.getTransactionCount({address:account.address,blockTag:'pending'}),settledSignatures=signatures
  assert.equal((await restarted.confirm({playerId,previewId:outputId})).status,'confirmed')
  assert.equal((await restarted.retry({playerId,previewId:outputId})).status,'confirmed')
  assert.equal(signatures,settledSignatures)
  assert.equal(await client.getTransactionCount({address:account.address,blockTag:'pending'}),settledNonce)
  assert.deepEqual((await market.balances({playerId})).tokens,afterOutput.tokens)
  check('exact-output-repeat-confirmation-and-retry-create-no-extra-signatures-or-spending')
  report.exactOutputSwaps=[outputResult]

  const latest=await client.getBlock({blockTag:'latest'})
  const zeroForOne=manifest.tokens.CITY.address===manifest.poolKey.currency0
  await assert.rejects(client.simulateContract({address:manifest.router,abi:MARKET_ABIS.router,functionName:'swapExactInput',account:account.address,
    args:['0x'+'12'.repeat(32),zeroForOne,parseUnits('1',18),parseUnits('100000',18),Number(latest.timestamp+60n)]}),/minimum output/)
  await assert.rejects(client.simulateContract({address:manifest.router,abi:MARKET_ABIS.router,functionName:'swapExactInput',account:account.address,
    args:['0x'+'13'.repeat(32),zeroForOne,parseUnits('1',18),1n,Number(latest.timestamp)]}),/quote expired/)
  const expired=await market.preview({playerId,operationId:randomUUID(),tokenIn:'CITY',tokenOut:'GEM',amountIn:'1',slippageBps:100,ttlSeconds:30})
  const expiredOutput=await market.preview({playerId,operationId:randomUUID(),tokenIn:'GEM',tokenOut:'CITY',amountOut:'1',maxAmountIn:'2',ttlSeconds:30})
  const signedBefore=(await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count
  await client.request({method:'evm_increaseTime',params:[31]});await client.request({method:'evm_mine'})
  assert.equal((await market.confirm({playerId,previewId:expired.previewId})).status,'expired')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count,signedBefore)
  assert.equal((await market.confirm({playerId,previewId:expiredOutput.previewId})).status,'expired')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ac_playable_testnet_chain_intents')).rows[0].count,signedBefore)
  check('real-EVM-minimum-output-and-expiry-refuse-without-new-swap-or-credit')
  report.status='pass';report.swaps=[result,reverseResult];report.history=await market.history({playerId})
  report.finalBalances=await market.balances({playerId})
  const paths=['backend/src/playable/uniswap-market.mjs','backend/src/playable/uniswap-market.sql','contracts/src/PlayableMarketRouter.sol','contracts/src/PlayableMarketToken.sol','scripts/playable_uniswap_setup.mjs','tests/playable/uniswap-market.mjs','backend/src/playable/swap-request.mjs','backend/src/playable/testnet-wallets.mjs','contracts/src/WorldAssetSwapRouter.sol','tests/contracts/ExactOutputSwap.t.sol']
  report.sourceHashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])))
}catch(error){report.error={name:error.name,message:error.message};process.exitCode=1}
finally{
  await pool?.end();await administrator?.end()
  report.finishedAt=new Date().toISOString()
  await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(evidence,'report.json'),error:report.error}))
}
