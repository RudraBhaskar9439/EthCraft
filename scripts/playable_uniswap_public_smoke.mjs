// Authorized developer fixture only. This is never a player-wallet provider.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { createUniswapMarket, validateMarketManifest } from '../backend/src/playable/uniswap-market.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
if (process.platform === 'win32' || process.argv.length !== 2) throw Error('Run the fixed developer fixture in WSL without arguments.')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = join(root, '.local/playable-testnet')
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const release = await acquireLocalLease('agentcity-new-playable-public-market-1301')
let administrator, store, reportPath
const report = { status: 'fail', scope: 'Actual faucet-funded DEVELOPER fixture, not a Privy player or independent human', tests: [], realMoneySpentUsd: 0, independentHumans: 0, managedPlayers: 0 }
try {
  const manifest = validateMarketManifest(await json(join(directory, 'market.json')))
  assert.equal(manifest.environment, 'UNICHAIN_SEPOLIA_PLAYABLE')
  const deployment = await json(join(directory, 'market-deployment-progress.json'))
  assert.equal(deployment.genesisHash, manifest.genesisHash)
  const metadata = await json(join(directory, 'account-settings.json'))
  assert.equal(metadata.address.toLowerCase(), deployment.developer)
  const developer = await openDevelopmentKeystore(metadata)
  const stateFile = join(directory, 'developer-swap-fixture.json')
  let state
  try { state = await json(stateFile) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { runId: randomUUID(), playerId: randomUUID(), operationId: randomUUID(), developer: developer.address.toLowerCase(), genesisHash: manifest.genesisHash }
    await writeCheckpoint(stateFile, state)
  }
  assert.equal(state.developer, developer.address.toLowerCase())
  assert.equal(state.genesisHash, manifest.genesisHash)
  const evidence = join(root, 'evidence/runs/playable-public-swap', state.runId)
  await mkdir(evidence, { recursive: true })
  reportPath = join(evidence, 'report.json')
  report.runId = state.runId
  report.developer = developer.address
  report.chainId = 1301
  const settings = await json(join(root, '.local/backend/environment.json'))
  administrator = new PostgresStore(settings.databaseUrl)
  const databaseUrl = new URL(settings.databaseUrl)
  databaseUrl.searchParams.set('options', '-c search_path=playable_market_deployment_1301')
  store = new PostgresStore(databaseUrl.toString())
  const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: [developer.address] })
  evm.nativeCap = BigInt(deployment.budgetWei)
  const owner = playerId => assert.equal(playerId, state.playerId, 'Fixed developer fixture identity only')
  const wallets = {
    async getOrCreate(playerId) { owner(playerId); return { address: developer.address, chainId: 1301, custody: 'explicit_developer_fixture' } },
    async prepare({ playerId, operationId, to, data, value }) {
      owner(playerId)
      assert.ok([manifest.tokens.CITY.address, manifest.router].includes(to.toLowerCase()))
      assert.equal(value, 0n)
      return evm.prepare(operationId, developer, to, data, value)
    },
    async broadcast({ playerId, operationId }) { owner(playerId); return evm.broadcast(operationId) },
    async reconcile({ playerId, operationId }) { owner(playerId); return evm.receipt(operationId, 2) }
  }
  const market = await createUniswapMarket({ pool: store.pool, wallets, manifest, client: evm.client })
  if (!state.before) { state.before = await market.balances({ playerId: state.playerId }); await writeCheckpoint(stateFile, state) }
  const preview = await market.preview({ playerId: state.playerId, operationId: state.operationId, tokenIn: 'CITY', tokenOut: 'GEM', amountIn: '1', slippageBps: 100, ttlSeconds: 120 })
  const count = async () => Number((await store.query('SELECT count(*) AS count FROM ac_chain_intents')).rows[0].count)
  const beforeConsent = await count()
  if (!preview.consented) {
    assert.equal((await market.retry({ playerId: state.playerId, previewId: state.operationId })).consented, false)
    assert.equal(await count(), beforeConsent)
  }
  report.tests.push({ name: 'unconfirmed-preview-retry-signs-zero-transactions', status: 'pass' })
  let result = await market.confirm({ playerId: state.playerId, previewId: state.operationId })
  for (let attempt = 0; attempt < 5 && !['confirmed', 'reverted', 'expired', 'reconciliation_required'].includes(result.status); attempt++) result = await market.retry({ playerId: state.playerId, previewId: state.operationId })
  assert.equal(result.status, 'confirmed', 'Retain original signed intents on failure; never create a fresh fixture operation')
  const after = await market.balances({ playerId: state.playerId })
  assert.equal(BigInt(state.before.tokens.CITY.baseUnits) - BigInt(after.tokens.CITY.baseUnits), 10n ** 18n)
  assert.equal(BigInt(after.tokens.GEM.baseUnits) - BigInt(state.before.tokens.GEM.baseUnits), BigInt(result.proof.swap.amountOutBaseUnits))
  report.tests.push({ name: 'actual-1CITY-swap-canonical-router-manager-transfers-and-balance-deltas', status: 'pass' })
  const intents = await count()
  const nonce = await evm.client.getTransactionCount({ address: developer.address, blockTag: 'pending' })
  const replay = await market.retry({ playerId: state.playerId, previewId: state.operationId })
  assert.equal(replay.status, 'confirmed')
  assert.equal(await count(), intents)
  assert.equal(await evm.client.getTransactionCount({ address: developer.address, blockTag: 'pending' }), nonce)
  assert.deepEqual((await market.balances({ playerId: state.playerId })).tokens, after.tokens)
  report.tests.push({ name: 'same-operation-retry-zero-additional-signs-transfers-or-nonce', status: 'pass' })
  Object.assign(report, { status: 'pass', preview, result, before: state.before, after, intentsAfterReplay: intents, maximumCombinedDeploymentAndSwapBudgetWei: deployment.budgetWei, gameCoinsCredited: false })
  await writeCheckpoint(reportPath, report)
  console.log(JSON.stringify({ status: 'pass', tests: report.tests.length, transactionHash: result.proof.swap.transactionHash, evidence: reportPath, scope: report.scope }))
} catch (error) {
  report.error = (error.shortMessage || error.message).split('\n')[0].slice(0, 400)
  if (reportPath) {
    // Preserve every failed attempt without overwriting earlier evidence.
    await writeCheckpoint(reportPath.replace(/report\.json$/, 'failure-' + randomUUID() + '.json'), report)
  }
  console.error(JSON.stringify({ status: 'fail', error: report.error, retainedOriginalOperations: true }))
  process.exitCode = 1
} finally {
  if (store) await store.close()
  if (administrator) await administrator.close()
  await release()
}
