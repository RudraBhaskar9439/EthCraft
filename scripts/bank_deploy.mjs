// Fresh testnet namespace; every signed bootstrap operation is durably retained.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { LocalEvm } from '../backend/src/chain/local-evm.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { ensureBankOperatorSettings } from './src/bank-keys.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters,
  parseAbiParameters, parseAbi, parseEventLogs, keccak256, stringToHex, getCreate2Address, toHex, zeroAddress } = require('viem')
const { foundry, unichainSepolia } = require('viem/chains')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = join(root, '.local/bank')
const flags = new Set(process.argv.slice(2))
assert([...flags].every(flag => ['--deploy', '--local', '--prepare-keys', '--check-math'].includes(flag)), 'Unknown bank setup argument')
const local = flags.has('--local'), execute = flags.has('--deploy')
const rpcUrl = local ? 'http://127.0.0.1:8561' : 'https://sepolia.unichain.org'
const chainId = local ? 31337 : 1301
const chain = local ? foundry : unichainSepolia
const budget = 4_000_000_000_000_000n
const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) })
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const hashFile = async path => createHash('sha256').update(await readFile(join(root, path))).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const pair = (a, b, fee, hooks) => ({ currency0: a < b ? a : b, currency1: a < b ? b : a, fee, tickSpacing: 60, hooks })

function liquidityTerms(coin, stable) {
  const coinFirst = coin < stable
  const price = coinFirst ? 1e-12 : 1e12
  const center = Math.floor(Math.log(price) / Math.log(1.0001) / 60) * 60
  return { sqrtPriceX96: coinFirst ? (2n ** 96n) / 1_000_000n : (2n ** 96n) * 1_000_000n,
    tickLower: center - 600, tickUpper: center + 600, liquidity: 10_000n * 10n ** 12n }
}

if (flags.has('--check-math')) {
  for (const [coin, stable] of [['0x1', '0x2'], ['0x2', '0x1']]) {
    const value = liquidityTerms(coin, stable)
    assert(value.tickLower % 60 === 0 && value.tickUpper % 60 === 0)
    assert(value.tickLower > -887272 && value.tickUpper < 887272)
    if (coin < stable) {
      assert(value.sqrtPriceX96 ** 2n * 10n ** 12n <= 2n ** 192n)
      assert((value.sqrtPriceX96 + 1n) ** 2n * 10n ** 12n > 2n ** 192n)
    } else assert.equal(value.sqrtPriceX96, (2n ** 96n) * 1_000_000n)
  }
  console.log(JSON.stringify({ status: 'pass', scope: 'Both 18/6-decimal currency orders and bounded LP tick math', publicTransactions: 0 }))
  process.exit(0)
}
if (flags.has('--prepare-keys')) {
  const keys = await ensureBankOperatorSettings(root)
  console.log(JSON.stringify({ status: 'ready', operatorControlled: true, roles: Object.fromEntries(Object.entries(keys.roles).map(([name, role]) => [name, role.address])), publicTransactions: 0 }))
  process.exit(0)
}

async function localNode() {
  const nodeDirectory = join(directory, 'local')
  const ownerPath = join(nodeDirectory, 'anvil-environment.json')
  const previous = await readJson(ownerPath)
  let connected = false
  try { connected = await client.getChainId() === 31337 } catch {}
  if (connected) {
    assert.equal(previous?.owner, 'agentcity-bank-local', 'Refuse an unowned node on port8561')
    assert.equal(previous.genesisHash, (await client.getBlock({ blockNumber: 0n })).hash)
    return previous
  }
  if (!execute) throw Error('Bank local node is offline; --local --deploy creates only a new owned fixture')
  assert(!previous, 'Owned bank node is offline; restore its saved state rather than silently replacing it')
  await mkdir(nodeDirectory, { recursive: true, mode: 0o700 })
  const output = await open(join(nodeDirectory, 'anvil.log'), 'a', 0o600)
  const child = spawn(join(homedir(), '.foundry/bin/anvil'), ['--host', '127.0.0.1', '--port', '8561', '--chain-id', '31337', '--silent',
    '--state', join(nodeDirectory, 'anvil-state.json'), '--state-interval', '1'], { cwd: root, detached: true, stdio: ['ignore', output.fd, output.fd] })
  child.unref(); await output.close()
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if (await client.getChainId() === 31337) { connected = true; break } } catch {}
    await delay(100)
  }
  assert(connected, 'Owned bank Anvil did not start; original log retained')
  const value = { owner: 'agentcity-bank-local', pid: child.pid, rpcUrl, chainId, genesisHash: (await client.getBlock({ blockNumber: 0n })).hash }
  await writeCheckpoint(ownerPath, value)
  return value
}

await mkdir(directory, { recursive: true, mode: 0o700 })
if (local) await localNode()
assert.equal(await client.getChainId(), chainId)
const genesisHash = (await client.getBlock({ blockNumber: 0n })).hash
const operator = await readJson(join(directory, 'operator-settings.json'))
assert.equal(operator?.schema, 'agentcity.bank-operator.v1', 'Run --prepare-keys before deployment')
const administrator = operator.roles.administrator.address
const balance = await client.getBalance({ address: administrator })
const cataloguePath = '.local/public-testnet/official-uniswap-deployments.json'
const catalogue = await readJson(join(root, cataloguePath))
const official = {}
if (!local) {
  for (const name of ['PoolManager', 'PositionManager', 'V4Quoter', 'Permit2']) {
    const records = catalogue.records.filter(value => value.chainId === 1301 && value.contract === name && value.env === 'testnet' && value.status === 'active')
    assert.equal(records.length, 1, 'One pinned official deployment required: ' + name)
    const record = records[0], code = await client.getCode({ address: record.address })
    assert(code && code !== '0x', 'Official runtime required: ' + name)
    official[name] = { address: record.address.toLowerCase(), codeHash: keccak256(code), sourceRef: record.sourceRef }
  }
  for (const name of ['PositionManager', 'V4Quoter']) assert.equal((await client.readContract({ address: official[name].address,
    abi: parseAbi(['function poolManager() view returns(address)']), functionName: 'poolManager' })).toLowerCase(), official.PoolManager.address)
  assert.equal((await client.readContract({ address: official.PositionManager.address,
    abi: parseAbi(['function permit2() view returns(address)']), functionName: 'permit2' })).toLowerCase(), official.Permit2.address)
}
const sourcePaths = ['AgentCityBank', 'AgentCityReputationHook', 'BankPaymentRouter', 'BankTestUSDC', 'AgentCityWorkEscrow',
  'WorldAssetRegistry', 'WorldAssetMarket', 'PlayableMarketToken', 'StateRegistry', 'DemoHookFactory'].map(name => 'contracts/src/' + name + '.sol')
sourcePaths.push('contracts/package-lock.json')
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(path)])))
if (!execute) {
  console.log(JSON.stringify({ status: local || balance > 0n ? 'ready' : 'faucet_funding_required', chainId, administrator,
    balanceWei: balance.toString(), maximumNativeBudgetWei: budget.toString(), official, sourceHashes, publicTransactions: 0 }))
  process.exit(local || balance > 0n ? 0 : 1)
}

const release = await acquireLocalLease('agentcity-bank-deployment-' + chainId)
let adminStore, store
try {
  const progressPath = join(directory, local ? 'local-deployment-progress.json' : 'public-deployment-progress.json')
  const outputPath = join(directory, local ? 'local-deployment.json' : 'public-deployment.json')
  let progress = await readJson(progressPath)
  if (!progress) {
    const runId = randomUUID()
    progress = { schema: 'agentcity.bank-deployment.v1', runId, chainId, rpcUrl, genesisHash, administrator: administrator.toLowerCase(),
      budgetWei: budget.toString(), journalSchema: 'bank_deployment_' + chainId + '_' + runId.replaceAll('-', '').slice(0, 12),
      official, sourceHashes, catalogueHash: await hashFile(cataloguePath), operations: {}, lpSnapshots: {} }
    await writeCheckpoint(progressPath, progress)
  }
  const save = () => writeCheckpoint(progressPath, progress)
  assert.deepEqual(progress.sourceHashes, sourceHashes, 'Preserve original contract sources and deployment intents')
  assert.equal(progress.genesisHash, genesisHash); assert.equal(progress.administrator, administrator.toLowerCase())
  assert.deepEqual(progress.official, official, 'Official contracts changed; retain prior intents')
  const metadata = [...Object.values(operator.roles), ...Object.values(operator.actors).map(actor => actor.wallet)]
  const accounts = new Map()
  for (const value of metadata) if (!accounts.has(value.address.toLowerCase())) accounts.set(value.address.toLowerCase(), await openDevelopmentKeystore(value))
  const role = name => accounts.get(operator.roles[name].address.toLowerCase())
  const actor = name => accounts.get(operator.actors[name].wallet.address.toLowerCase())
  if (local && Object.keys(progress.operations).length === 0) {
    for (const account of accounts.values()) {
      if (await client.getBalance({ address: account.address }) === 0n) await client.request({ method: 'anvil_setBalance', params: [account.address, toHex(10n ** 19n)] })
    }
  }
  const database = await readJson(join(root, '.local/backend/environment.json'))
  adminStore = new PostgresStore(database.databaseUrl)
  assert(/^[a-z][a-z0-9_]{1,62}$/.test(progress.journalSchema))
  await adminStore.query('CREATE SCHEMA IF NOT EXISTS ' + progress.journalSchema)
  const databaseUrl = new URL(database.databaseUrl)
  databaseUrl.searchParams.set('options', '-c search_path=' + progress.journalSchema)
  store = new PostgresStore(databaseUrl.toString())
  await store.migrate([new URL('../backend/src/chain/schema.sql', import.meta.url)])
  const evm = local ? new LocalEvm({ store, rpcUrl, genesisHash }) : new PublicTestnetEvm({ store, chainId, rpcUrl, genesisHash,
    environment: 'PUBLIC_TESTNET_WORLD_ASSETS', allowedSigners: [...accounts.keys()] })
  if (!local) evm.nativeCap = budget
  const artifacts = new Map()
  async function artifact(name) {
    if (!artifacts.has(name)) {
      const compiled = await readJson(join(root, 'contracts/out', name + '.sol', name + '.json'))
      assert(compiled?.bytecode?.object && compiled.bytecode.object !== '0x', 'Compile artifact: ' + name)
      const path = 'contracts/src/' + name + '.sol'
      if (sourcePaths.includes(path)) assert.equal(compiled.metadata.sources['src/' + name + '.sol'].keccak256,
        keccak256(toHex(await readFile(join(root, path)))), 'Artifact source differs: ' + name)
      artifacts.set(name, compiled)
    }
    return artifacts.get(name)
  }
  async function send(label, account, to, data, value = 0n) {
    if (!progress.operations[label]) { progress.operations[label] = { id: randomUUID() }; await save() }
    const operation = progress.operations[label]
    await evm.prepare(operation.id, account, to, data, value)
    const submitted = await evm.broadcast(operation.id)
    assert.equal(submitted.status, 'submitted', label + ': original signed intent retained; reconcile before retry')
    let result
    for (let attempt = 0; attempt < (local ? 40 : 4); attempt++) {
      result = await evm.receipt(operation.id, local ? 1 : 2)
      if (result.status === 'confirmed' || result.status === 'reverted') break
      await delay(local ? 100 : 1000)
    }
    assert.equal(result.status, 'confirmed', label + ': do not replace an unknown or reverted intent')
    operation.hash = result.hash; operation.blockNumber = String(result.receipt.blockNumber)
    operation.gasUsed = String(result.receipt.gasUsed); operation.effectiveGasPrice = String(result.receipt.effectiveGasPrice)
    await save(); console.log(JSON.stringify({ confirmed: label, hash: result.hash }))
    return result.receipt
  }
  async function call(label, account, address, abi, method, args) { return send(label, account, address, encodeFunctionData({ abi, functionName: method, args })) }
  async function deploy(label, name, args) {
    const compiled = await artifact(name)
    const receipt = await send('deploy-' + label, role('administrator'), null, encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }))
    assert(receipt.contractAddress); return receipt.contractAddress.toLowerCase()
  }
  if (!local) for (const account of accounts.values()) if (account.address.toLowerCase() !== administrator.toLowerCase()) {
    await send('fund-' + account.address.toLowerCase(), role('administrator'), account.address, '0x', 50_000_000_000_000n)
  }
  const usdc = await deploy('mock-USDC', 'BankTestUSDC', [administrator, role('issuer').address])
  const city = await deploy('CITY', 'PlayableMarketToken', ['AgentCity Bank Test CITY', 'CITY', administrator, role('issuer').address, 1_000_000n * 10n ** 18n])
  const gem = await deploy('GEM', 'PlayableMarketToken', ['AgentCity Bank Test GEM', 'GEM', administrator, role('issuer').address, 1_000_000n * 10n ** 18n])
  const registry = await deploy('asset-registry', 'WorldAssetRegistry', [administrator, role('registrar').address])
  const market = await deploy('asset-market', 'WorldAssetMarket', [registry, city])
  const bank = await deploy('bank', 'AgentCityBank', [registry, usdc, role('lender').address])
  const marketId = keccak256(stringToHex('agentcity-bank:' + progress.runId))
  const stateRegistry = await deploy('state-registry', 'StateRegistry', [role('publisher').address, marketId])
  const manager = local ? await deploy('local-manager', 'PoolManager', [administrator]) : official.PoolManager.address
  const quoter = local ? await deploy('local-quoter', 'V4Quoter', [manager]) : official.V4Quoter.address
  const factory = await deploy('hook-factory', 'DemoHookFactory', [])
  const hookArtifact = await artifact('AgentCityReputationHook')
  const hookCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode.object,
    args: [manager, stateRegistry, bank, quoter, administrator, city, usdc] })
  let hook, salt
  for (let nonce = 0; ; nonce++) {
    salt = toHex(nonce, { size: 32 }); hook = getCreate2Address({ from: factory, salt, bytecodeHash: keccak256(hookCode) })
    if ((BigInt(hook) & 0x3fffn) === 0x80n) break
  }
  await call('deploy-reputation-hook', role('administrator'), factory, (await artifact('DemoHookFactory')).abi, 'deploy', [salt, hookCode])
  const cityPool = pair(city, usdc, 0x800000, hook), gemPool = pair(gem, usdc, 3000, zeroAddress)
  const initializeAbi = parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160) returns(int24)'])
  for (const [name, key, coin] of [['CITY', cityPool, city], ['GEM', gemPool, gem]]) {
    await call('initialize-' + name + '-pool', role('administrator'), manager, initializeAbi, 'initialize', [key, liquidityTerms(coin, usdc).sqrtPriceX96])
  }
  const router = await deploy('payment-router', 'BankPaymentRouter', [manager, market, usdc, cityPool, gemPool])
  await call('bind-reputation-router', role('administrator'), hook, hookArtifact.abi, 'bindRouter', [router])
  const workEscrow = await deploy('work-escrow', 'AgentCityWorkEscrow', [city, role('inspector').address])
  const usdcAbi = (await artifact('BankTestUSDC')).abi, tokenAbi = (await artifact('PlayableMarketToken')).abi
  const grants = [['USDC', usdc, usdcAbi, role('liquidity'), 2000n * 10n ** 6n], ['CITY', city, tokenAbi, role('liquidity'), 1000n * 10n ** 18n],
    ['GEM', gem, tokenAbi, role('liquidity'), 1000n * 10n ** 18n], ['USDC', usdc, usdcAbi, role('lender'), 1000n * 10n ** 6n],
    ['USDC', usdc, usdcAbi, actor('borrower'), 2n * 10n ** 6n], ['GEM', gem, tokenAbi, actor('borrower'), 100n * 10n ** 18n],
    ['CITY', city, tokenAbi, actor('seller'), 100n * 10n ** 18n], ['USDC', usdc, usdcAbi, actor('bidder'), 100n * 10n ** 6n]]
  for (const [symbol, address, abi, recipient, amount] of grants) {
    await call('mint-' + symbol + '-' + recipient.address.toLowerCase(), role('issuer'), address, abi, 'mint', [recipient.address, amount])
  }
  const localLiquidity = local ? await deploy('local-liquidity-fixture', 'PoolModifyLiquidityTest', [manager]) : null
  if (!progress.permitExpiry) {
    const now = (await client.getBlock()).timestamp
    progress.permitExpiry = String(now + 24n * 3600n); progress.positionDeadline = String(now + 6n * 3600n); await save()
  }
  for (const [name, key, coin] of [['cityUsdc', cityPool, city], ['gemUsdc', gemPool, gem]]) {
    if (progress.lpSnapshots[name]?.deposited) {
      const savedReceipt = await client.getTransactionReceipt({ hash: progress.lpSnapshots[name].transactionHash })
      assert.equal(savedReceipt.status, 'success', 'Preserve original funded LP position')
      assert.equal(savedReceipt.blockHash, (await client.getBlock({ blockNumber: savedReceipt.blockNumber })).hash)
      continue
    }
    const math = liquidityTerms(coin, usdc)
    if (!progress.lpSnapshots[name]) {
      const entries = await Promise.all([coin, usdc].map(async token => {
        const amount = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [role('liquidity').address] })
        return [token, String(amount)]
      }))
      progress.lpSnapshots[name] = { before: Object.fromEntries(entries) }
      await save()
    }
    for (const token of [coin, usdc]) {
      const amount = token === usdc ? 2000n * 10n ** 6n : 1000n * 10n ** 18n
      await call('approve-liquidity-' + name + '-' + token, role('liquidity'), token, tokenAbi, 'approve', [local ? localLiquidity : official.Permit2.address, amount])
      if (!local) await call('approve-permit-' + name + '-' + token, role('liquidity'), official.Permit2.address,
        parseAbi(['function approve(address,address,uint160,uint48)']), 'approve', [token, official.PositionManager.address, amount, Number(progress.permitExpiry)])
    }
    let receipt
    if (local) {
      receipt = await call('seed-' + name, role('liquidity'), localLiquidity, (await artifact('PoolModifyLiquidityTest')).abi,
        'modifyLiquidity', [key, { tickLower: math.tickLower, tickUpper: math.tickUpper, liquidityDelta: math.liquidity, salt: toHex(0, { size: 32 }) }, '0x'])
    } else {
      const amount0Max = key.currency0 === usdc ? 1000n * 10n ** 6n : 1000n * 10n ** 18n
      const amount1Max = key.currency1 === usdc ? 1000n * 10n ** 6n : 1000n * 10n ** 18n
      const mint = encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'),
        [key, math.tickLower, math.tickUpper, math.liquidity, amount0Max, amount1Max, role('liquidity').address, '0x'])
      const settle = encodeAbiParameters(parseAbiParameters('address,address'), [key.currency0, key.currency1])
      const unlock = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x020d', [mint, settle]])
      receipt = await call('seed-' + name, role('liquidity'), official.PositionManager.address,
        parseAbi(['function modifyLiquidities(bytes,uint256) payable']), 'modifyLiquidities', [unlock, BigInt(progress.positionDeadline)])
      const transfers = parseEventLogs({ abi: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']),
        eventName: 'Transfer', logs: receipt.logs.filter(value => value.address.toLowerCase() === official.PositionManager.address), strict: true })
      const position = transfers.filter(value => value.args.from === zeroAddress && value.args.to.toLowerCase() === role('liquidity').address.toLowerCase())
      assert.equal(position.length, 1, 'One actual official LP position receipt required')
      progress.lpSnapshots[name].positionId = String(position[0].args.tokenId)
    }
    const deposited = {}
    for (const token of [coin, usdc]) {
      const after = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [role('liquidity').address] })
      deposited[token] = String(BigInt(progress.lpSnapshots[name].before[token]) - after)
      assert(BigInt(deposited[token]) > 0n)
    }
    progress.lpSnapshots[name] = { ...progress.lpSnapshots[name], deposited, liquidity: String(math.liquidity),
      tickLower: math.tickLower, tickUpper: math.tickUpper, transactionHash: receipt.transactionHash,
      disclosure: 'Initial seed price near1wholeCITY/GEM=1mocktUSDC, not a peg or redemption promise.' }
    await save()
  }
  const publisherAbi = (await artifact('StateRegistry')).abi
  if (!progress.statePublication) { progress.statePublication = { sequence: 1, validUntil: Number((await client.getBlock()).timestamp + 300n) }; await save() }
  await call('publish-bootstrap-availability', role('publisher'), stateRegistry, publisherAbi, 'publish', [progress.statePublication.sequence, true, progress.statePublication.validUntil])
  const addresses = { registry, market, city, usdc, gem, bank, router, hook: hook.toLowerCase(), stateRegistry, workEscrow, poolManager: manager, quoter }
  const codeHashes = {}
  for (const [name, address] of Object.entries(addresses)) { const code = await client.getCode({ address }); assert(code && code !== '0x'); codeHashes[name] = keccak256(code) }
  const deploymentId = keccak256(stringToHex('agentcity-bank-deployment:' + progress.runId)), serverId = keccak256(stringToHex(operator.serverId))
  const worldAssets = { schema: 'agentcity.world-assets.v1', environment: local ? 'LOCAL_TEST_FIXTURE' : 'UNICHAIN_SEPOLIA_WORLD_ASSETS', chainId, rpcUrl, genesisHash,
    deploymentId, serverId, registry, market, city, confirmations: 2, maxPriceBaseUnits: String(100n * 10n ** 18n), maxGas: '1000000', maxNativeCostWei: '500000000000000',
    codeHashes: { registry: codeHashes.registry, market: codeHashes.market, city: codeHashes.city } }
  const manifest = { schema: 'agentcity.bank.v1', environment: local ? 'LOCAL_TEST_FIXTURE' : 'UNICHAIN_SEPOLIA_BANK', chainId, rpcUrl, genesisHash, deploymentId, serverId,
    serverIdText: operator.serverId, ...addresses, codeHashes, pools: { cityUsdc: cityPool, gemUsdc: gemPool }, worldAssets,
    roles: Object.fromEntries(Object.entries(operator.roles).map(([name, value]) => [name, value.address.toLowerCase()])),
    confirmations: 2, maxGas: 3000000, maxNativeCostWei: '500000000000000', maxCityAmountBaseUnits: String(100n * 10n ** 18n), maxUsdcAmountBaseUnits: '30000000',
    tokens: { CITY: { address: city, decimals: 18 }, GEM: { address: gem, decimals: 18 }, USDC: { address: usdc, decimals: 6, symbol: 'tUSDC', mock: true, circleIssued: false } },
    operatorControlled: true, mockUSDC: true, journalSchema: progress.journalSchema, maximumNativeBudgetWei: budget.toString(), official, sourceHashes,
    positionManager: local ? null : official.PositionManager.address, permit2: local ? null : official.Permit2.address,
    localFixture: local ? { owner: 'agentcity-bank-local', liquidityHelper: localLiquidity } : null, liquidity: progress.lpSnapshots, deploymentRunId: progress.runId }
  await writeCheckpoint(outputPath, manifest)
  const evidence = join(root, 'evidence/runs/bank-deployment', progress.runId)
  await mkdir(evidence, { recursive: true })
  await writeCheckpoint(join(evidence, 'report.json'), { status: 'pass', scope: local ? 'Isolated owned Anvil banking deployment with actual v4 and disclosed LP fixture' :
    'Actual Unichain Sepolia contracts and official PositionManager LP positions; operator-controlled test tokens, no Circle USDC, no native collateral issued by deployment',
    manifest, operations: progress.operations, originalSourceHashes: sourceHashes, realMoneySpentUsd: 0, independentHumans: 0, nativeItemsRegistered: 0,
    executionGasCostWei: Object.values(progress.operations).reduce((sum, value) => sum + BigInt(value.gasUsed) * BigInt(value.effectiveGasPrice), 0n).toString() })
  console.log(JSON.stringify({ status: 'pass', manifest: outputPath, evidence, chainId, nativeItemsRegistered: 0, independentHumans: 0 }))
} finally { await store?.close(); await adminStore?.close(); await release() }
