// Fresh guarded marketplace pool. Historical bank contracts, manifests and LPs
// remain unchanged; all new signing uses their existing capped transaction journal.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { LocalEvm } from '../backend/src/chain/local-evm.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters,
  parseAbiParameters, parseAbi, parseEventLogs, keccak256, stringToHex, getCreate2Address, toHex, zeroAddress } = require('viem')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const root = fileURLToPath(new URL('../', import.meta.url)), flags = new Set(process.argv.slice(2))
assert([...flags].every(value => ['--local', '--deploy', '--warm', '--check-math'].includes(value)), 'Unknown marketplace deployment argument')
const local = flags.has('--local'), execute = flags.has('--deploy')
const directory = join(root, '.local/marketplace')
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const math = (coin, stable) => {
  const coinFirst = coin.toLowerCase() < stable.toLowerCase()
  const center = Math.floor(Math.log(coinFirst ? 1e-12 : 1e12) / Math.log(1.0001) / 60) * 60
  return { sqrtPriceX96: coinFirst ? (2n ** 96n) / 1_000_000n : (2n ** 96n) * 1_000_000n,
    tickLower: center - 600, tickUpper: center + 600, liquidity: 10_000n * 10n ** 12n, minActiveLiquidity: 10n ** 15n }
}
if (flags.has('--check-math')) {
  for (const [coin, stable] of [['0x1', '0x2'], ['0x2', '0x1']]) {
    const value = math(coin, stable)
    assert(value.tickLower % 60 === 0 && value.tickUpper % 60 === 0 && value.tickLower > -887272 && value.tickUpper < 887272)
    if (coin < stable) {
      assert(value.sqrtPriceX96 ** 2n * 10n ** 12n <= 2n ** 192n)
      assert((value.sqrtPriceX96 + 1n) ** 2n * 10n ** 12n > 2n ** 192n)
    } else assert.equal(value.sqrtPriceX96, (2n ** 96n) * 1_000_000n)
    assert(value.liquidity >= value.minActiveLiquidity)
  }
  console.log(JSON.stringify({ status: 'pass', scope: 'Both18/6decimal seed orders, LP tick bounds and explicit liquidity threshold', publicTransactions: 0 }))
  process.exit(0)
}
const basePath = join(root, '.local/bank', local ? 'local-deployment.json' : 'public-deployment.json')
const baseBytes = await readFile(basePath), base = JSON.parse(baseBytes)
const settings = await readJson(join(root, '.local/bank/operator-settings.json'))
assert.equal(base.chainId, local ? 31337 : 1301)
assert.equal(base.schema, 'agentcity.bank.v1')
assert.equal(settings.operatorControlled, true)
const client = createPublicClient({ transport: http(base.rpcUrl, { retryCount: 0, timeout: 15000 }) })
assert.equal(await client.getChainId(), base.chainId)
assert.equal((await client.getBlock({ blockNumber: 0n })).hash, base.genesisHash)
if (local) {
  const owner = await readJson(join(root, '.local/bank/local/anvil-environment.json'))
  assert.equal(owner?.owner, 'agentcity-bank-local'); assert.equal(owner.genesisHash, base.genesisHash)
  assert.equal(base.rpcUrl, 'http://127.0.0.1:8561')
}
for (const [name, expected] of Object.entries(base.sourceHashes)) assert.equal(sha(await readFile(join(root, name))), expected, 'Historical pinned source changed: ' + name)
for (const [name, expected] of Object.entries(base.codeHashes)) assert.equal(keccak256(await client.getCode({ address: base[name] })), expected, 'Historical runtime changed: ' + name)
const hookName = 'AgentCityMarketplaceHook', hookSource = 'contracts/src/' + hookName + '.sol'
const sourceHashes = { ...base.sourceHashes, [hookSource]: sha(await readFile(join(root, hookSource))) }
const oldProgress = await readJson(join(root, '.local/bank', local ? 'local-deployment-progress.json' : 'public-deployment-progress.json'))
const factoryReceipt = await client.getTransactionReceipt({ hash: oldProgress.operations['deploy-hook-factory'].hash })
assert.equal(factoryReceipt.status, 'success')
assert.equal(factoryReceipt.blockHash, (await client.getBlock({ blockNumber: factoryReceipt.blockNumber })).hash)
const factory = factoryReceipt.contractAddress
assert(factory)
const addressAbi = name => parseAbi(['function ' + name + '() view returns(address)'])
assert.equal((await client.readContract({ address: factory, abi: addressAbi('deployer'), functionName: 'deployer' })).toLowerCase(), settings.roles.administrator.address.toLowerCase())
const plan = math(base.city, base.usdc), tokenAbi = parseAbi(['function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'])
const lp = settings.roles.liquidity.address
const balances = Object.fromEntries(await Promise.all([base.city, base.usdc].map(async token => [token,
  String(await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [lp] }))])))
if (!execute) {
  console.log(JSON.stringify({ status: 'ready', scope: 'Read-only fresh marketplace preflight; historical contracts and LPs preserved',
    chainId: base.chainId, inheritedJournalSchema: base.journalSchema, maximumNativeBudgetWei: base.maximumNativeBudgetWei,
    sources: sourceHashes, unusedLpBalances: balances, plan: json(plan), publicTransactions: 0 }))
  process.exit(0)
}
await mkdir(directory, { recursive: true, mode: 0o700 })
const release = await acquireLocalLease('agentcity-marketplace-deployment-' + base.chainId)
let adminStore, store
try {
  const progressPath = join(directory, local ? 'local-deployment-progress.json' : 'public-deployment-progress.json')
  const outputPath = join(directory, local ? 'local-deployment.json' : 'public-deployment.json')
  let progress = await readJson(progressPath)
  if (!progress) {
    progress = { schema: 'agentcity.marketplace-deployment.v1', runId: randomUUID(), chainId: base.chainId, genesisHash: base.genesisHash,
      inheritedManifestSha256: sha(baseBytes), journalSchema: base.journalSchema, maximumNativeBudgetWei: base.maximumNativeBudgetWei,
      sourceHashes, operations: {}, oldPositions: base.liquidity, oldFactory: factory, initialLpBalances: balances }
    await writeCheckpoint(progressPath, progress)
  }
  const save = () => writeCheckpoint(progressPath, progress)
  assert.equal(progress.inheritedManifestSha256, sha(baseBytes), 'Do not overwrite or rewrite the historical bank manifest')
  assert.deepEqual(progress.sourceHashes, sourceHashes, 'Preserve original marketplace sources/intents')
  assert.equal(progress.journalSchema, base.journalSchema)
  const accounts = {}
  for (const name of ['administrator', 'liquidity']) accounts[name] = await openDevelopmentKeystore(settings.roles[name])
  const database = await readJson(join(root, '.local/backend/environment.json'))
  adminStore = new PostgresStore(database.databaseUrl)
  assert(/^[a-z][a-z0-9_]{1,62}$/.test(base.journalSchema))
  const url = new URL(database.databaseUrl); url.searchParams.set('options', '-c search_path=' + base.journalSchema)
  store = new PostgresStore(url.toString())
  const evm = local ? new LocalEvm({ store, rpcUrl: base.rpcUrl, genesisHash: base.genesisHash }) : new PublicTestnetEvm({ store,
    chainId: 1301, rpcUrl: base.rpcUrl, genesisHash: base.genesisHash, environment: 'PUBLIC_TESTNET_WORLD_ASSETS',
    allowedSigners: Object.values(accounts).map(value => value.address) })
  if (!local) evm.nativeCap = BigInt(base.maximumNativeBudgetWei)
  const artifact = async name => {
    const value = await readJson(join(root, 'contracts/out', name + '.sol', name + '.json'))
    assert(value?.bytecode?.object && value.bytecode.object !== '0x', 'Compile ' + name)
    assert.equal(value.metadata.sources['src/' + name + '.sol'].keccak256,
      keccak256(toHex(await readFile(join(root, 'contracts/src', name + '.sol')))), 'Artifact source mismatch: ' + name)
    return value
  }
  async function send(label, account, to, data) {
    if (!progress.operations[label]) { progress.operations[label] = { id: randomUUID() }; await save() }
    const value = progress.operations[label]
    await evm.prepare(value.id, account, to, data, 0n)
    assert.equal((await evm.broadcast(value.id)).status, 'submitted', 'Retain original unknown signed intent')
    let result
    for (let attempt = 0; attempt < (local ? 50 : 4); attempt++) {
      result = await evm.receipt(value.id, local ? 1 : 2)
      if (['confirmed', 'reverted'].includes(result.status)) break
      await delay(local ? 100 : 1000)
    }
    assert.equal(result.status, 'confirmed', label + ': original intent requires reconciliation')
    Object.assign(value, { hash: result.hash, blockNumber: String(result.receipt.blockNumber), gasUsed: String(result.receipt.gasUsed) })
    await save(); console.log(JSON.stringify({ confirmed: label, hash: result.hash }))
    return result.receipt
  }
  const call = (label, account, address, abi, name, args = []) => send(label, account, address, encodeFunctionData({ abi, functionName: name, args }))
  const hookArtifact = await artifact(hookName), routerArtifact = await artifact('BankPaymentRouter')
  const bytecode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode.object,
    args: [base.poolManager, base.stateRegistry, accounts.administrator.address, base.city, base.usdc, base.quoter, plan.minActiveLiquidity] })
  let hook, salt
  for (let nonce = 0; ; nonce++) {
    salt = toHex(nonce, { size: 32 }); hook = getCreate2Address({ from: factory, salt, bytecodeHash: keccak256(bytecode) })
    if ((BigInt(hook) & 0x3fffn) === 0x1fc0n) break
  }
  const factoryArtifact = await artifact('DemoHookFactory')
  await call('deploy-marketplace-hook', accounts.administrator, factory, factoryArtifact.abi, 'deploy', [salt, bytecode])
  const key = { ...base.pools.cityUsdc, hooks: hook }
  await call('initialize-marketplace-pool', accounts.administrator, base.poolManager,
    parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160) returns(int24)']), 'initialize', [key, plan.sqrtPriceX96])
  const routerReceipt = await send('deploy-marketplace-router', accounts.administrator, null, encodeDeployData({ abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode.object, args: [base.poolManager, base.market, base.usdc, key, base.pools.gemUsdc] }))
  const router = routerReceipt.contractAddress.toLowerCase()
  await call('bind-marketplace-router', accounts.administrator, hook, hookArtifact.abi, 'bindRouter', [router])
  if (!progress.lpPosition) {
    const maximum = token => token === base.usdc ? 500n * 10n ** 6n : 500n * 10n ** 18n
    if (!progress.lpBefore) {
      progress.lpBefore = balances
      progress.permitExpiry = String((await client.getBlock()).timestamp + 86400n)
      progress.positionDeadline = String((await client.getBlock()).timestamp + 21600n)
      await save()
    }
    for (const token of [base.city, base.usdc]) {
      assert(BigInt(progress.lpBefore[token]) >= maximum(token), 'Existing unused LP test funds required; no new mint authorized')
      await call('approve-lp-' + token, accounts.liquidity, token, tokenAbi, 'approve', [local ? base.localFixture.liquidityHelper : base.permit2, maximum(token)])
      if (!local) await call('approve-permit-' + token, accounts.liquidity, base.permit2,
        parseAbi(['function approve(address,address,uint160,uint48)']), 'approve', [token, base.positionManager, maximum(token), Number(progress.permitExpiry)])
    }
    let positionReceipt, positionId = null
    if (local) {
      positionReceipt = await call('seed-marketplace-position', accounts.liquidity, base.localFixture.liquidityHelper,
        parseAbi(['function modifyLiquidity((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),(int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt),bytes) returns(bytes32)']),
        'modifyLiquidity', [key, { tickLower: plan.tickLower, tickUpper: plan.tickUpper, liquidityDelta: plan.liquidity, salt: toHex(0, { size: 32 }) }, '0x'])
    } else {
      const mint = encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'),
        [key, plan.tickLower, plan.tickUpper, plan.liquidity, maximum(key.currency0), maximum(key.currency1), lp, '0x'])
      const settle = encodeAbiParameters(parseAbiParameters('address,address'), [key.currency0, key.currency1])
      const unlock = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x020d', [mint, settle]])
      positionReceipt = await call('seed-marketplace-position', accounts.liquidity, base.positionManager,
        parseAbi(['function modifyLiquidities(bytes,uint256) payable']), 'modifyLiquidities', [unlock, BigInt(progress.positionDeadline)])
      const transfers = parseEventLogs({ abi: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']), eventName: 'Transfer',
        logs: positionReceipt.logs.filter(value => value.address.toLowerCase() === base.positionManager), strict: true })
      const minted = transfers.filter(value => value.args.from === zeroAddress && value.args.to.toLowerCase() === lp.toLowerCase())
      assert.equal(minted.length, 1); positionId = String(minted[0].args.tokenId)
    }
    const deposited = {}
    for (const token of [base.city, base.usdc]) {
      const after = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [lp] })
      deposited[token] = String(BigInt(progress.lpBefore[token]) - after)
      assert(BigInt(deposited[token]) > 0n && BigInt(deposited[token]) <= maximum(token))
    }
    progress.lpPosition = { owner: lp.toLowerCase(), positionId, deposited, liquidity: String(plan.liquidity), minActiveLiquidity: String(plan.minActiveLiquidity),
      tickLower: plan.tickLower, tickUpper: plan.tickUpper, transactionHash: positionReceipt.transactionHash,
      disclosure: 'Unused operator test funds, initial seed near1wholeCITY=1mocktUSDC; not a peg, independent fair-value oracle or production liquidity promise.' }
    await save()
  }
  if (!local) {
    for (const value of Object.values(base.liquidity)) assert.equal((await client.readContract({ address: base.positionManager,
      abi: parseAbi(['function ownerOf(uint256) view returns(address)']), functionName: 'ownerOf', args: [BigInt(value.positionId)] })).toLowerCase(), lp.toLowerCase())
  }
  const codeHashes = { ...base.codeHashes, hook: keccak256(await client.getCode({ address: hook })), router: keccak256(await client.getCode({ address: router })) }
  const readHook = name => client.readContract({ address: hook, abi: hookArtifact.abi, functionName: name })
  const constants = ['WINDOW', 'MAX_REFERENCE_AGE', 'SAMPLE_INTERVAL', 'MAX_DEVIATION_TICKS', 'MAX_IMPACT_TICKS', 'MAX_EXECUTION_DEVIATION_BPS',
    'MAX_CITY_OUTPUT', 'MAX_USDC_OUTPUT', 'BLOCK_CITY_OUTPUT', 'BLOCK_USDC_OUTPUT', 'BASE_FEE', 'MAX_FEE']
  const guard = Object.fromEntries(await Promise.all(constants.map(async name => [name, String(await readHook(name))])))
  const manifest = { ...base, mode: 'marketplace', deploymentId: keccak256(stringToHex('agentcity-marketplace:' + progress.runId)),
    router, hook: hook.toLowerCase(), codeHashes, pools: { cityUsdc: key, gemUsdc: base.pools.gemUsdc }, sourceHashes,
    marketplace: { guard, minActiveLiquidity: String(plan.minActiveLiquidity), supportedActiveTokens: ['USDC', 'CITY'], activeCreditFeatures: false,
      average: 'Geometric time-weighted mean tick over a matured300–600second anchor interval; not an arithmetic average or manipulation-proof price.',
      checkpointIntervalSeconds: 30, sourceHook: hookName, initialLiquidity: progress.lpPosition },
    historicalDeployment: { deploymentId: base.deploymentId, manifestSha256: sha(baseBytes), manifestUnchanged: true,
      bank: base.bank, router: base.router, hook: base.hook, positionsPreserved: base.liquidity },
    deploymentRunId: progress.runId }
  await writeCheckpoint(outputPath, json(manifest))
  if (!local) {
    const safe = { schema: 'agentcity.marketplace-public.v1', mode: 'marketplace', chainId: manifest.chainId, rpcUrl: manifest.rpcUrl,
      deploymentId: manifest.deploymentId, sourceHashes, tokens: { CITY: base.tokens.CITY, USDC: base.tokens.USDC },
      contracts: { registry: base.registry, market: base.market, router, hook: manifest.hook, workEscrow: base.workEscrow, poolManager: base.poolManager, quoter: base.quoter },
      poolKey: key, codeHashes, marketplace: manifest.marketplace, mockUSDC: true, circleIssuedUSDC: false,
      disclosure: 'Operator-controlled testnet marketplace; lending/borrowing/auctions/credit reputation are archived and disabled in the active application.' }
    await writeCheckpoint(join(root, 'config/marketplace-public-deployment.json'), json(safe))
  }
  console.log(JSON.stringify({ status: 'deployed', manifest: outputPath, mode: 'marketplace', waitingForMatureReference: true }))
  if (flags.has('--warm')) {
    let attempt = progress.warmCheckpoints || 0
    for (;;) {
      const reference = await readHook('marketReference')
      if (reference[0]) { progress.referenceAtVerification = json(reference); break }
      assert(attempt < 30, 'Mature reference still unavailable; preserve all original deployments and observations')
      if (local) {
        await client.request({ method: 'evm_increaseTime', params: [31] }); await client.request({ method: 'evm_mine', params: [] })
      } else await delay(31000)
      await call('oracle-checkpoint-' + attempt, accounts.administrator, hook, hookArtifact.abi, 'checkpoint')
      attempt++; progress.warmCheckpoints = attempt; await save()
      console.log(JSON.stringify({ stage: 'reference_warmup', checkpoint: attempt, simulatedLocalTime: local }))
    }
    progress.referenceStatus = 'ready'; await save()
  }
  assert.equal(sha(await readFile(basePath)), progress.inheritedManifestSha256, 'Historical manifest must remain unchanged')
  const evidence = join(root, 'evidence/runs/marketplace-deployment', progress.runId)
  await mkdir(evidence, { recursive: true })
  await writeCheckpoint(join(evidence, 'report.json'), json({ status: flags.has('--warm') ? 'pass' : 'deployed_reference_warmup_required',
    scope: local ? 'Owned local fixture, oracle warmup advances disclosed Anvil time' : 'Fresh actual Unichain Sepolia guarded CITY/tUSDC marketplace and official LP position',
    manifest, referenceAtVerification: progress.referenceAtVerification || null, operations: progress.operations,
    historicalManifestSha256: progress.inheritedManifestSha256, historicalPositionsPreserved: true, realMoneySpentUsd: 0, newLendingTransactions: 0,
    newlyIssuedTokens: 0, independentHumans: 0, simulatedLocalClock: local }))
  console.log(JSON.stringify({ status: flags.has('--warm') ? 'pass' : 'deployed', evidence, manifest: outputPath }))
} finally { await store?.close(); await adminStore?.close(); await release() }
