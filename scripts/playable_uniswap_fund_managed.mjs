// Fixed one-time faucet test grants, never a sale receipt or a user-authorized swap.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { MARKET_ABIS, validateMarketManifest } from '../backend/src/playable/uniswap-market.mjs'
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { encodeFunctionData, parseTransaction, parseEventLogs } = require('viem')
const { writeCheckpoint, acquireLocalLease } = require('./src/bot/checkpoint-store.cjs')
if (process.platform === 'win32' || process.argv.length !== 2) throw Error('Fixed funding CLI requires WSL without arguments')
const root = fileURLToPath(new URL('../', import.meta.url)), directory = join(root, '.local/playable-testnet')
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const release = await acquireLocalLease('agentcity-new-playable-public-market-1301')
let store, reportPath
const report = { status: 'fail', scope: 'Disclosed one-time faucet test grants to actual Privy-managed treasury and Ruddy wallet; not item-sale proceeds or a human trade', realMoneySpentUsd: 0, independentHumans: 0 }
try {
  const manifest = validateMarketManifest(await json(join(directory, 'market.json')))
  assert.equal(manifest.environment, 'UNICHAIN_SEPOLIA_PLAYABLE')
  const deployment = await json(join(directory, 'market-deployment-progress.json'))
  const metadata = await json(join(directory, 'account-settings.json'))
  assert.equal(metadata.address.toLowerCase(), deployment.developer)
  assert.equal(deployment.genesisHash, manifest.genesisHash)
  const account = await openDevelopmentKeystore(metadata)
  const settings = await json(join(root, '.local/backend/environment.json'))
  const databaseUrl = new URL(settings.databaseUrl)
  databaseUrl.searchParams.set('options', '-c search_path=playable_market_deployment_1301')
  store = new PostgresStore(databaseUrl.toString())
  const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: [account.address] })
  evm.nativeCap = BigInt(deployment.budgetWei)
  await evm.verify()
  const token = manifest.tokens.CITY.address
  const terms = { chainId: 1301, genesisHash: manifest.genesisHash, developer: account.address.toLowerCase(), token,
    allocations: [
      { label: 'treasury', address: '0x245167cc2cd6ddb264adb83b49f1b3d910a51f67', cityBaseUnits: String(10000n * 10n ** 18n), nativeWei: '2000000000000000' },
      { label: 'Ruddy', address: '0x27f53660a409d14a3acc5f2e82ba9a7077090c96', cityBaseUnits: String(20n * 10n ** 18n), nativeWei: '2000000000000000' }
    ] }
  const stateFile = join(directory, 'managed-funding.json')
  let state
  try { state = await json(stateFile) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { runId: randomUUID(), terms, operations: Object.fromEntries(terms.allocations.flatMap(allocation => ['CITY', 'native'].map(kind => [allocation.label + '-' + kind, { id: randomUUID() }]))) }
    await writeCheckpoint(stateFile, state)
  }
  assert.deepEqual(state.terms, terms, 'Fixed grant binding changed; never replace or refill an allocation')
  const evidence = join(root, 'evidence/runs/playable-managed-funding', state.runId)
  await mkdir(evidence, { recursive: true })
  reportPath = join(evidence, 'report.json')
  const reservedRows = (await store.query('SELECT operation_id,raw_transaction FROM ac_chain_intents WHERE chain_instance=$1', [evm.instance])).rows
  const reserved = reservedRows.reduce((sum, row) => { const tx = parseTransaction(row.raw_transaction); return sum + BigInt(tx.gas) * BigInt(tx.maxFeePerGas ?? tx.gasPrice) + BigInt(tx.value || 0n) }, 0n)
  const existingIds = new Set(reservedRows.map(row => row.operation_id))
  const remainingNative = terms.allocations.reduce((sum, allocation) => sum + (existingIds.has(state.operations[allocation.label + '-native'].id) ? 0n : BigInt(allocation.nativeWei)), 0n)
  const unfinished = Object.values(state.operations).filter(operation => !existingIds.has(operation.id)).length
  const gasHeadroom = unfinished ? 1000000000000000n : 0n
  report.preflight = { maximumCombinedBudgetWei: deployment.budgetWei, alreadyReservedWei: String(reserved), remainingNativeGrantWei: String(remainingNative), conservativeNewGasHeadroomWei: String(gasHeadroom) }
  console.log(JSON.stringify({ fundingPreflight: report.preflight }))
  assert.ok(reserved + remainingNative + gasHeadroom <= evm.nativeCap, 'Original combined budget insufficient: no smaller or replacement allocation is authorized by this CLI')
  const balance = await evm.client.readContract({ address: token, abi: MARKET_ABIS.token, functionName: 'balanceOf', args: [account.address] })
  const remainingTokens = terms.allocations.reduce((sum, allocation) => sum + (state.operations[allocation.label + '-CITY'].hash ? 0n : BigInt(allocation.cityBaseUnits)), 0n)
  assert.ok(balance >= remainingTokens, 'Finite developer CITY balance insufficient; do not mint replacement stock')
  for (const allocation of terms.allocations) {
    for (const kind of ['CITY', 'native']) {
      const operation = state.operations[allocation.label + '-' + kind]
      const to = kind === 'CITY' ? token : allocation.address
      const data = kind === 'CITY' ? encodeFunctionData({ abi: MARKET_ABIS.token, functionName: 'transfer', args: [allocation.address, BigInt(allocation.cityBaseUnits)] }) : '0x'
      const value = kind === 'CITY' ? 0n : BigInt(allocation.nativeWei)
      await evm.prepare(operation.id, account, to, data, value)
      await evm.broadcast(operation.id)
      const result = await evm.receipt(operation.id, 2)
      assert.equal(result.status, 'confirmed', 'Retain original grant intent on uncertain receipt; do not refill')
      const transaction = await evm.client.getTransaction({ hash: result.hash })
      assert.equal(transaction.from.toLowerCase(), account.address.toLowerCase())
      assert.equal(transaction.to.toLowerCase(), to.toLowerCase())
      assert.equal(transaction.input, data)
      assert.equal(transaction.value, value)
      if (kind === 'CITY') {
        const transfers = parseEventLogs({ abi: MARKET_ABIS.token, eventName: 'Transfer', logs: result.receipt.logs, strict: true }).filter(log => log.address.toLowerCase() === token && log.args.from.toLowerCase() === account.address.toLowerCase() && log.args.to.toLowerCase() === allocation.address && log.args.value === BigInt(allocation.cityBaseUnits))
        assert.equal(transfers.length, 1)
      }
      Object.assign(operation, { hash: result.hash, blockNumber: String(result.receipt.blockNumber), kind, recipient: allocation.address, amount: kind === 'CITY' ? allocation.cityBaseUnits : allocation.nativeWei })
      await writeCheckpoint(stateFile, state)
      console.log(JSON.stringify({ confirmed: allocation.label + '-' + kind, hash: result.hash }))
    }
  }
  report.recipients = []
  for (const allocation of terms.allocations) report.recipients.push({ ...allocation,
    actualCityBaseUnits: String(await evm.client.readContract({ address: token, abi: MARKET_ABIS.token, functionName: 'balanceOf', args: [allocation.address] })),
    actualNativeWei: String(await evm.client.getBalance({ address: allocation.address })) })
  Object.assign(report, { status: 'pass', terms, operations: state.operations, grantsOnly: true, inventoryRemoved: 0, userSpendingAuthorized: false })
  await writeCheckpoint(reportPath, report)
  console.log(JSON.stringify({ status: 'pass', evidence: reportPath, allocations: report.recipients }))
} catch (error) {
  report.error = (error.shortMessage || error.message).split('\n')[0].slice(0, 500)
  if (reportPath) await writeCheckpoint(reportPath.replace('report.json', 'failure-' + randomUUID() + '.json'), report)
  console.error(JSON.stringify({ status: 'fail', error: report.error, originalAllocationIdsRetained: true }))
  process.exitCode = 1
} finally { if (store) await store.close(); await release() }
