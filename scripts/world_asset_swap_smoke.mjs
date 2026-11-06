// Fixed, explicitly authorized OPERATOR testnet swap. Never a player transaction.
// Default is read-only. --execute is required and must follow the root GO.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, delimiter } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { createUniswapMarket, validateMarketManifest, MARKET_ABIS } from '../backend/src/playable/uniswap-market.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, parseAbi, keccak256, parseUnits, parseTransaction } = require('viem')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const root = fileURLToPath(new URL('../', import.meta.url)), directory = join(root, '.local/world-assets')
const execute = process.argv.length === 3 && process.argv[2] === '--execute'
if (process.argv.length > 2 && !execute) throw Error('Use no arguments for read-only preflight or --execute for the fixed0.01CITY operator swap.')
const read = async file => { try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const manifest = validateMarketManifest(await read(join(directory, 'payment-market.json')))
assert.equal(manifest.schema, 'agentcity.playable-market.v2'); assert.equal(manifest.chainId, 1301)
assert.notEqual(manifest.poolKey.hooks, '0x0000000000000000000000000000000000000000')
const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 15000, retryCount: 0 }) })
const report = { runId: randomUUID(), status: 'fail', mode: execute ? 'explicit_operator_execution' : 'read_only_preflight',
  scope: 'Existing encrypted developer account only; fixed0.01CITY→GEM through the new hooked v4 pool. No player wallet, NFT mint, human-consent claim or Game Coins.',
  allocationWei: '100000000000000', amountIn: '0.01', tokenIn: 'CITY', tokenOut: 'GEM', slippageBps: 100,
  realMoneySpentUsd: 0, playerWallets: 0, tests: [] }
let admin, store, release, reportFile
try {
  const evidence = join(root, 'evidence/runs/world-asset-swap', report.runId)
  await mkdir(evidence, { recursive: true }); reportFile = join(evidence, execute ? 'attempt.json' : 'preflight.json')
  assert.equal(await client.getChainId(), 1301); assert.equal((await client.getBlock({ blockNumber: 0n })).hash.toLowerCase(), manifest.genesisHash.toLowerCase())
  for (const key of ['poolManager', 'quoter', 'router', 'CITY', 'GEM', 'hook', 'stateRegistry']) {
    const address = manifest.tokens[key]?.address || manifest[key], code = await client.getCode({ address })
    assert(code && code !== '0x'); assert.equal(keccak256(code).toLowerCase(), manifest.codeHashes[key].toLowerCase(), key + ' code changed')
  }
  const hookAbi = parseAbi(['function registry() view returns(address)', 'function poolManager() view returns(address)', 'function currency0() view returns(address)', 'function currency1() view returns(address)'])
  for (const [name, expected] of [['registry', manifest.stateRegistry], ['poolManager', manifest.poolManager], ['currency0', manifest.poolKey.currency0], ['currency1', manifest.poolKey.currency1]]) assert.equal((await client.readContract({ address: manifest.hook, abi: hookAbi, functionName: name })).toLowerCase(), expected)
  for (const [address, abi] of [[manifest.router, MARKET_ABIS.router], [manifest.quoter, MARKET_ABIS.quoter]]) assert.equal((await client.readContract({ address, abi, functionName: 'poolManager' })).toLowerCase(), manifest.poolManager)
  const key = await client.readContract({ address: manifest.router, abi: MARKET_ABIS.router, functionName: 'poolKey' })
  assert.deepEqual([key[0].toLowerCase(), key[1].toLowerCase(), key[2], key[3], key[4].toLowerCase()], [manifest.poolKey.currency0, manifest.poolKey.currency1, 3000, 60, manifest.hook])
  const stateAbi = parseAbi(['function marketId() view returns(bytes32)', 'function available() view returns(bool)', 'function healthy() view returns(bool)', 'function validUntil() view returns(uint64)', 'function sequence() view returns(uint64)'])
  assert.equal((await client.readContract({ address: manifest.stateRegistry, abi: stateAbi, functionName: 'marketId' })).toLowerCase(), manifest.marketId.toLowerCase())
  const head = await client.getBlockNumber({ cacheTime: 0 }); assert(head >= 1n)
  const block = await client.getBlock({ blockNumber: head - 1n }), latest = await client.getBlock({ blockNumber: head })
  assert(Date.now() - Number(latest.timestamp) * 1000 < 45000, 'RPC must be current')
  assert(Number(latest.timestamp) * 1000 <= Date.now() + 5000, 'RPC block timestamp is unexpectedly in the future')
  const state = {}
  for (const name of ['healthy', 'available', 'validUntil', 'sequence']) state[name] = await client.readContract({ address: manifest.stateRegistry, abi: stateAbi, functionName: name, blockNumber: block.number })
  const currentlyAvailable = await client.readContract({ address: manifest.stateRegistry, abi: stateAbi, functionName: 'available' })
  report.preflight = { chainId: 1301, router: manifest.router, hook: manifest.hook, stateRegistry: manifest.stateRegistry, marketId: manifest.marketId,
    blockNumber: String(block.number), blockHash: block.hash, confirmations: 2, healthy: state.healthy, available: state.available,
    currentlyAvailable, validUntil: String(state.validUntil), sequence: String(state.sequence), ready: state.healthy && state.available && currentlyAvailable && state.validUntil > latest.timestamp + 10n }
  if (!execute) { report.status = report.preflight.ready ? 'ready' : 'pending_world_health'; console.log(JSON.stringify({ status: report.status, preflight: report.preflight, transactionsSubmitted: 0, evidence: reportFile })) }
  else {
    assert(report.preflight.ready, 'Wait for root-activated, native-verified canonical world-health publication before executing.')
    assert.notEqual(process.platform, 'win32', 'Use WSL with the existing private encrypted developer account.')
    release = await acquireLocalLease('agentcity-world-assets-operator-swap-1301')
    const metadata = await read(join(root, '.local/playable-testnet/account-settings.json'))
    assert.equal(metadata.chainId, 1301); assert.equal(metadata.address.toLowerCase(), manifest.developer.toLowerCase())
    const cast = join(root, '.local/tools/foundry-linux/cast'); assert.match(execFileSync(cast, ['--version'], { encoding: 'utf8' }), /^cast Version: 1\.7\.1\b/m)
    process.env.PATH = join(root, '.local/tools/foundry-linux') + delimiter + process.env.PATH
    const developer = await openDevelopmentKeystore(metadata), stateFile = join(directory, 'operator-swap-progress.json')
    let progress = await read(stateFile)
    if (!progress) { progress = { schema: 'agentcity.world-asset-operator-swap.v1', manifestDigest: hash(manifest), developer: developer.address.toLowerCase(), operatorId: randomUUID(), previews: [randomUUID()] }; await writeCheckpoint(stateFile, progress) }
    assert.equal(progress.schema, 'agentcity.world-asset-operator-swap.v1'); assert.equal(progress.manifestDigest, hash(manifest)); assert.equal(progress.developer, developer.address.toLowerCase())
    const settings = await read(join(root, '.local/backend/environment.json')), schema = 'world_asset_operator_swap_1301'
    admin = new PostgresStore(settings.databaseUrl); await admin.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    const url = new URL(settings.databaseUrl); url.searchParams.set('options', '-c search_path=' + schema)
    store = new PostgresStore(url.toString()); await store.migrate([new URL('../backend/src/chain/schema.sql', import.meta.url)])
    const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, environment: 'PUBLIC_TESTNET_WORLD_ASSETS', allowedSigners: [developer.address] })
    evm.nativeCap = 100000000000000n
    const operator = playerId => assert.equal(playerId, progress.operatorId, 'Operator-only journal alias, never a player identity')
    const wallets = { async getOrCreate(playerId) { operator(playerId); return { address: developer.address, chainId: 1301, custody: 'existing_operator_account' } },
      async prepare({ playerId, operationId, to, data, value }) { operator(playerId); assert([manifest.router, manifest.tokens.CITY.address].includes(to.toLowerCase())); assert.equal(value, 0n); return evm.prepare(operationId, developer, to, data, value) },
      async broadcast({ playerId, operationId }) { operator(playerId); return evm.broadcast(operationId) }, async reconcile({ playerId, operationId }) { operator(playerId); return evm.receipt(operationId, 2) } }
    const market = await createUniswapMarket({ pool: store.pool, wallets, manifest, client: evm.client })
    let previewId = progress.previews.at(-1), preview = await market.preview({ playerId: progress.operatorId, operationId: previewId, amountIn: '0.01', tokenIn: 'CITY', tokenOut: 'GEM', slippageBps: 100, ttlSeconds: 120 })
    // A fresh unsigned quote may replace an expired quote. Signed swap bytes are
    // immutable; an unknown approval must settle before any quote refresh.
    const record = (await store.query('SELECT * FROM ac_playable_market_previews WHERE preview_id=$1', [previewId])).rows[0]
    if (BigInt(preview.deadline) <= (await client.getBlock()).timestamp) {
      const swap = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [record.swap_operation_id])).rows[0]
      if (!swap) {
        const approval = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [record.approval_operation_id])).rows[0]
        assert(!approval || ['confirmed', 'reverted'].includes(approval.status), 'Original approval is still uncertain; do not refresh.')
        previewId = randomUUID(); progress.previews.push(previewId); await writeCheckpoint(stateFile, progress)
        preview = await market.preview({ playerId: progress.operatorId, operationId: previewId, amountIn: '0.01', tokenIn: 'CITY', tokenOut: 'GEM', slippageBps: 100, ttlSeconds: 120 })
      } // Signed swap: reconcile only its original immutable bytes/deadline.
    }
    assert(BigInt(preview.minimumOutBaseUnits) > 0n); assert.equal(preview.amountInBaseUnits, parseUnits('0.01', 18).toString())
    if (!progress.before) { progress.before = await market.balances({ playerId: progress.operatorId }); await writeCheckpoint(stateFile, progress) }
    const result = await market.confirm({ playerId: progress.operatorId, previewId })
    assert.equal(result.status, 'confirmed', 'Original signed intents retained; retry this script without resetting progress.')
    const after = await market.balances({ playerId: progress.operatorId })
    assert.equal(BigInt(progress.before.tokens.CITY.baseUnits) - BigInt(after.tokens.CITY.baseUnits), parseUnits('0.01', 18))
    assert.equal(BigInt(after.tokens.GEM.baseUnits) - BigInt(progress.before.tokens.GEM.baseUnits), BigInt(result.proof.swap.amountOutBaseUnits))
    report.tests.push({ name: 'actual-hooked-pool-router-event-official-manager-pool-transfers-and-exact-balance-deltas', status: 'pass' })
    const intents = (await store.query('SELECT operation_id,raw_transaction,transaction_hash FROM ac_chain_intents ORDER BY operation_id')).rows
    const count = intents.length, nonce = await client.getTransactionCount({ address: developer.address, blockTag: 'pending' })
    const replay = await market.retry({ playerId: progress.operatorId, previewId }); assert.equal(replay.status, 'confirmed')
    assert.equal(Number((await store.query('SELECT count(*) AS count FROM ac_chain_intents')).rows[0].count), count)
    assert.equal(await client.getTransactionCount({ address: developer.address, blockTag: 'pending' }), nonce)
    assert.deepEqual((await market.balances({ playerId: progress.operatorId })).tokens, after.tokens)
    const reserved = intents.reduce((sum, row) => { const tx = parseTransaction(row.raw_transaction); return sum + BigInt(tx.gas) * BigInt(tx.maxFeePerGas ?? tx.gasPrice) + BigInt(tx.value || 0n) }, 0n)
    assert(reserved <= 100000000000000n)
    report.tests.push({ name: 'same-operation-retry-zero-new-intents-nonce-or-token-effects-with-total-native-reservation-cap', status: 'pass' })
    report.status = 'pass'; Object.assign(report, { developer: developer.address, previewId, preview, result, before: progress.before, after, reservedNativeWei: String(reserved), intentHashes: intents.map(row => ({ operationId: row.operation_id, transactionHash: row.transaction_hash })) })
    progress.proof = result.proof; progress.confirmed = true; await writeCheckpoint(stateFile, progress)
    console.log(JSON.stringify({ status: 'pass', transactionHash: result.proof.swap.transactionHash, evidence: reportFile, tests: report.tests.length }))
  }
} catch (error) { report.error = String(error.shortMessage || error.message).split('\n')[0].slice(0, 400); process.exitCode = 1; console.error(JSON.stringify({ status: 'fail', error: report.error, originalIntentsPreserved: true, evidence: reportFile })) }
finally { if (reportFile) await writeCheckpoint(reportFile, report); await store?.close(); await admin?.close(); if (release) await release() }
