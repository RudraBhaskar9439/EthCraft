// Dedicated faucet-only CITY/GEM deployment. Never reads or changes old market roles.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { ensureTestnetKeystore } from '../backend/src/playable/testnet-wallets.mjs'
import { MARKET_ABIS, validateMarketManifest } from '../backend/src/playable/uniswap-market.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbi, keccak256, zeroAddress } = require('viem')
const { unichainSepolia } = require('viem/chains')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = join(root, '.local/playable-testnet')
const rpcUrl = 'https://sepolia.unichain.org'
const execute = process.argv.length === 3 && process.argv[2] === '--deploy'
if (process.argv.length > 2 && !execute) throw Error('Use no arguments for read-only preflight, or --deploy for faucet-funded deployment.')
if (process.platform === 'win32') throw Error('Protected development signing requires WSL.')
const client = createPublicClient({ chain: unichainSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) })
const json = async path => { try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function save(path, value) {
  await writeCheckpoint(path, value)
}
await mkdir(directory, { recursive: true, mode: 0o700 })
const release = await acquireLocalLease('agentcity-new-playable-public-market-1301')
let store, administrator
try {
  await (async () => {
  const metadata = await json(join(directory, 'account-settings.json'))
  assert.equal(metadata?.environment, 'UNICHAIN_SEPOLIA_PLAYABLE')
  assert.equal(metadata.chainId, 1301)
  assert.equal(metadata.rpcUrl, rpcUrl)
  assert.equal(metadata.address.toLowerCase(), '0x5caec1fd260ad8bb747a3984752d7943bcdc4a54')
  assert.equal(await client.getChainId(), 1301)
  const genesisHash = (await client.getBlock({ blockNumber: 0n })).hash
  const balance = await client.getBalance({ address: metadata.address })
  const catalogueBytes = await readFile(join(directory, 'official-uniswap-deployments.json'), 'utf8')
  const catalogue = JSON.parse(catalogueBytes.replace(/^\uFEFF/, ''))
  const official = {}
  for (const name of ['PoolManager', 'PositionManager', 'Permit2', 'V4Quoter']) {
    const matches = catalogue.records.filter(record => record.chainId === 1301 && record.contract === name && record.env === 'testnet' && record.status === 'active')
    assert.equal(matches.length, 1, 'Exactly one official active deployment: ' + name)
    const record = matches[0]
    const code = await client.getCode({ address: record.address })
    assert.ok(code && code !== '0x', name + ' has runtime code')
    official[name] = { address: record.address.toLowerCase(), codeHash: keccak256(code), sourceRef: record.sourceRef }
  }
  // Confirm the immutable upstream dependencies, not merely presence of bytecode.
  for (const name of ['V4Quoter', 'PositionManager']) {
    assert.equal((await client.readContract({ address: official[name].address, abi: parseAbi(['function poolManager() view returns(address)']), functionName: 'poolManager' })).toLowerCase(), official.PoolManager.address)
  }
  assert.equal((await client.readContract({ address: official.PositionManager.address, abi: parseAbi(['function permit2() view returns(address)']), functionName: 'permit2' })).toLowerCase(), official.Permit2.address)
  const paths = ['contracts/src/PlayableMarketToken.sol', 'contracts/src/PlayableMarketRouter.sol', 'contracts/package-lock.json', 'contracts/out/PlayableMarketToken.sol/PlayableMarketToken.json', 'contracts/out/PlayableMarketRouter.sol/PlayableMarketRouter.json']
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  const progressPath = join(directory, 'market-deployment-progress.json')
  let progress = await json(progressPath)
  if (!progress) {
    if (balance === 0n || !execute) {
      console.log(JSON.stringify({ status: balance === 0n ? 'blocked' : 'ready', scope: 'Read-only new public market preflight', developer: metadata.address, chainId: 1301, balanceWei: balance.toString(), maximumBudgetWei: '8000000000000000', official, publicTransactions: 0 }))
      process.exitCode = balance === 0n ? 1 : 0
      return
    }
    progress = { runId: randomUUID(), chainId: 1301, genesisHash, developer: metadata.address.toLowerCase(), initialBalanceWei: balance.toString(), budgetWei: (balance < 8000000000000000n ? balance : 8000000000000000n).toString(), official, sourceHashes, catalogueHash: createHash('sha256').update(catalogueBytes).digest('hex'), operations: {} }
    await save(progressPath, progress)
  }
  assert.equal(progress.genesisHash, genesisHash)
  assert.equal(progress.developer, metadata.address.toLowerCase())
  assert.deepEqual(progress.official, official, 'Official runtime/source identity changed; retain prior intents.')
  assert.deepEqual(progress.sourceHashes, sourceHashes, 'Deployment sources changed; retain prior intents.')
  if (!execute) { console.log(JSON.stringify({ status: 'in_progress', runId: progress.runId, balanceWei: balance.toString(), operations: Object.keys(progress.operations), publicTransactions: 0 })); return }
  const existing = await json(join(directory, 'market.json'))
  if (existing) {
    const manifest = validateMarketManifest(existing)
    for (const key of ['poolManager', 'quoter', 'router', 'CITY', 'GEM']) assert.equal(keccak256(await client.getCode({ address: manifest.tokens[key]?.address || manifest[key] })), manifest.codeHashes[key])
    console.log(JSON.stringify({ status: 'pass', reused: true, manifest: join(directory, 'market.json'), publicTransactions: 0 }))
    return
  }
  const developer = await openDevelopmentKeystore(metadata)
  const issuerMetadata = await ensureTestnetKeystore({ rootDirectory: root, privateRoot: metadata.privateRoot, keyId: 'role-market-issuer', environment: 'UNICHAIN_SEPOLIA_PLAYABLE' })
  assert.notEqual(issuerMetadata.address.toLowerCase(), developer.address.toLowerCase())
  if (progress.issuer) assert.equal(progress.issuer, issuerMetadata.address)
  else { progress.issuer = issuerMetadata.address; await save(progressPath, progress) }
  const issuer = await openDevelopmentKeystore(issuerMetadata)
  const settings = await json(join(root, '.local/backend/environment.json'))
  administrator = new PostgresStore(settings.databaseUrl)
  const schema = 'playable_market_deployment_1301'
  await administrator.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
  const databaseUrl = new URL(settings.databaseUrl)
  databaseUrl.searchParams.set('options', '-c search_path=' + schema)
  store = new PostgresStore(databaseUrl.toString())
  await store.migrate([new URL('../backend/src/chain/schema.sql', import.meta.url)])
  const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl, genesisHash, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: [developer.address, issuer.address] })
  evm.nativeCap = BigInt(progress.budgetWei)
  const artifact = async name => JSON.parse(await readFile(join(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'))
  async function send(name, account, to, data, value = 0n) {
    if (!progress.operations[name]) { progress.operations[name] = { id: randomUUID() }; await save(progressPath, progress) }
    const operation = progress.operations[name]
    await evm.prepare(operation.id, account, to, data, value)
    const submitted = await evm.broadcast(operation.id)
    if (submitted.status !== 'submitted') throw Error(name + ': unknown send retained for reconciliation')
    const result = await evm.receipt(operation.id, 2)
    assert.equal(result.status, 'confirmed', name + ': retain original intent; do not redeploy or change deadline')
    operation.hash = result.hash
    operation.blockNumber = result.receipt.blockNumber.toString()
    operation.gasUsed = result.receipt.gasUsed.toString()
    await save(progressPath, progress)
    console.log(JSON.stringify({ confirmed: name, hash: result.hash }))
    return result.receipt
  }
  async function call(name, account, address, abi, method, args) { return send(name, account, address, encodeFunctionData({ abi, functionName: method, args })) }
  async function deploy(label, name, args) {
    const compiled = await artifact(name)
    const receipt = await send('deploy-' + label, developer, null, encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }))
    assert.ok(receipt.contractAddress)
    return receipt.contractAddress.toLowerCase()
  }
  await send('fund-new-issuer', developer, issuer.address, '0x', 50000000000000n)
  const cap = 1000000n * 10n ** 18n
  const CITY = await deploy('CITY', 'PlayableMarketToken', ['AgentCity Test CITY', 'CITY', developer.address, issuer.address, cap])
  const GEM = await deploy('GEM', 'PlayableMarketToken', ['AgentCity Test GEM', 'GEM', developer.address, issuer.address, cap])
  const currencies = [CITY, GEM].sort()
  const poolKey = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60, hooks: zeroAddress }
  await call('initialize-dedicated-pool', developer, official.PoolManager.address, parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160) returns(int24)']), 'initialize', [poolKey, 2n ** 96n])
  const router = await deploy('fixed-router', 'PlayableMarketRouter', [official.PoolManager.address, poolKey])
  const tokenAbi = (await artifact('PlayableMarketToken')).abi
  for (const [symbol, address] of [['CITY', CITY], ['GEM', GEM]]) await call('mint-finite-' + symbol, issuer, address, tokenAbi, 'mint', [developer.address, 100000n * 10n ** 18n])
  if (!progress.permitExpiry) { progress.permitExpiry = ((await client.getBlock()).timestamp + 3600n).toString(); progress.positionDeadline = ((await client.getBlock()).timestamp + 1200n).toString(); await save(progressPath, progress) }
  const allowance = 10000n * 10n ** 18n
  for (const token of currencies) {
    await call('approve-permit2-' + token, developer, token, tokenAbi, 'approve', [official.Permit2.address, allowance])
    await call('approve-position-' + token, developer, official.Permit2.address, parseAbi(['function approve(address,address,uint160,uint48)']), 'approve', [token, official.PositionManager.address, allowance, Number(progress.permitExpiry)])
  }
  const mint = encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'), [poolKey, -600, 600, 10000n * 10n ** 18n, allowance, allowance, developer.address, '0x'])
  const settle = encodeAbiParameters(parseAbiParameters('address,address'), currencies)
  const unlock = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x020d', [mint, settle]])
  await call('seed-official-position', developer, official.PositionManager.address, parseAbi(['function modifyLiquidities(bytes,uint256) payable']), 'modifyLiquidities', [unlock, BigInt(progress.positionDeadline)])
  const manifest = { schema: 'agentcity.playable-market.v1', environment: 'UNICHAIN_SEPOLIA_PLAYABLE', chainId: 1301, rpcUrl, genesisHash,
    poolManager: official.PoolManager.address, quoter: official.V4Quoter.address, router, tokens: { CITY: { address: CITY, decimals: 18 }, GEM: { address: GEM, decimals: 18 } }, poolKey,
    codeHashes: {}, exactOutputEnabled: true, maxInputBaseUnits: '100000000000000000000', maxNativeCostWei: '2000000000000000', official, sourceHashes,
    developer: developer.address, issuer: issuer.address, positionManager: official.PositionManager.address, permit2: official.Permit2.address,
    gameCoinsBacked: false, minecraftInventoryBacked: false, confirmations: 2, deploymentRunId: progress.runId }
  for (const key of ['poolManager', 'quoter', 'router', 'CITY', 'GEM']) manifest.codeHashes[key] = keccak256(await client.getCode({ address: manifest.tokens[key]?.address || manifest[key] }))
  const quote = await client.simulateContract({ address: manifest.quoter, abi: MARKET_ABIS.quoter, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: true, exactAmount: 10n ** 18n, hookData: '0x' }] })
  assert.ok(quote.result[0] > 0n, 'New public pool produces actual official v4 quote')
  assert.equal(await client.readContract({address:router,abi:MARKET_ABIS.router,functionName:'supportsExactOutput'}),true)
  validateMarketManifest(manifest)
  await save(join(directory, 'market.json'), manifest)
  const evidence = join(root, 'evidence/runs/playable-public-market', progress.runId)
  await mkdir(evidence, { recursive: true })
  await save(join(evidence, 'report.json'), { status: 'pass', scope: 'New faucet-funded Unichain Sepolia CITY/GEM pool with official v4 liquidity and quote; no player swap claimed', manifest, operations: progress.operations, maximumReservedNativeWei: progress.budgetWei, actualQuoteAmountOut: quote.result[0].toString(), realMoneySpentUsd: 0, independentHumans: 0 })
  console.log(JSON.stringify({ status: 'pass', manifest: join(directory, 'market.json'), evidence, quoteAmountOut: quote.result[0].toString() }))
  })()
} finally {
  if (store) await store.close()
  if (administrator) await administrator.close()
  await release()
}
