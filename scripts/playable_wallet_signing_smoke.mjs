// Explicitly authorized operator grant: one CITY from the managed treasury to
// the already enrolled Ruddy wallet. This is not a sale or human trade.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createTestnetWallets, loadPrivySettings } from '../backend/src/playable/testnet-wallets.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { Pool } = require('pg')
const { encodeFunctionData, parseAbi, decodeEventLog, keccak256 } = require('viem')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
if (process.platform === 'win32' || process.argv.length !== 3 || process.argv[2] !== '--execute') throw Error('EXPLICIT_FIXED_OPERATOR_SMOKE_EXECUTION_REQUIRED')
const release = await acquireLocalLease('agentcity-managed-treasury-signing-smoke-1301')
const directory = join(root, '.local/playable-testnet')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const statePath = join(directory, 'treasury-signing-smoke.json')
const treasuryAddress = '0x245167cc2cd6ddb264adb83b49f1b3d910a51f67'
const recipientAddress = '0x27f53660a409d14a3acc5f2e82ba9a7077090c96'
const amount = 10n ** 18n
const allocationCapWei = 2000000000000000n
const abi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function transfer(address to,uint256 value) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)'])
let pool, reportPath
const report = { status: 'fail', scope: 'Actual managed Privy delegate signing of one authorized 1CITY operator smoke grant; not an inventory sale, player spend, or human trade', tests: [], publicTransactionsAuthorized: 1, realMoneySpentUsd: 0 }
const pass = name => report.tests.push({ name, status: 'pass' })
try {
  const manifest = await json(join(directory, 'market.json'))
  assert.equal(manifest.chainId, 1301); assert.equal(manifest.environment, 'UNICHAIN_SEPOLIA_PLAYABLE')
  assert.equal(manifest.rpcUrl, 'https://sepolia.unichain.org')
  assert.equal(BigInt(manifest.maxNativeCostWei), allocationCapWei, 'Never raise the immutable native cap')
  const binding = { chainId: 1301, genesisHash: manifest.genesisHash, role: 'treasury', treasury: treasuryAddress,
    recipient: recipientAddress, token: manifest.tokens.CITY.address.toLowerCase(), amountBaseUnits: amount.toString(),
    data: encodeFunctionData({ abi, functionName: 'transfer', args: [recipientAddress, amount] }), value: '0',
    maxNativeCostWei: allocationCapWei.toString(), maxGas: 100000 }
  let state
  try { state = await json(statePath) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { runId: randomUUID(), operationId: randomUUID(), binding, signRequests: 0 }
    await writeCheckpoint(statePath, state)
  }
  assert.deepEqual(state.binding, binding, 'Retain original operation and terms on every retry')
  const evidence = join(root, 'evidence/runs/playable-managed-signing', state.runId)
  await mkdir(evidence, { recursive: true })
  reportPath = join(evidence, randomUUID() + '.json')
  Object.assign(report, { operationId: state.operationId, binding })
  const database = await json(join(root, '.local/backend/environment.json'))
  pool = new Pool({ connectionString: database.databaseUrl, max: 3 })
  const { settings, provider } = await loadPrivySettings(root)
  assert.equal(settings.allowBroadcast, false, 'Global broadcast setting must stay disabled')
  const player = (await pool.query(`SELECT w.*,b.privy_subject FROM ac_playable_testnet_wallets w
    JOIN ac_wallet_identity_bindings b ON w.wallet_id='UNICHAIN_SEPOLIA_PLAYABLE:'||b.player_id::text
    WHERE b.player_name='Ruddy' AND b.app_id=$1 AND w.address=$2 AND w.provider_type='privy'`, [settings.appId, recipientAddress])).rows
  assert.equal(player.length, 1)
  assert.equal(player[0].auth_subject_hash, createHash('sha256').update(player[0].privy_subject).digest('hex'))
  await provider.validateConfiguration({ role: 'treasury' })
  const signingProvider = { ...provider, async signTransaction(request) {
    assert.equal(request.role, 'treasury'); assert.equal(request.operationId, state.operationId)
    const saved = (await pool.query('SELECT unsigned_request,signing_status FROM ac_playable_testnet_requests WHERE operation_id=$1', [state.operationId])).rows[0]
    assert.deepEqual(saved.unsigned_request, request.transaction)
    assert.equal(saved.signing_status, 'signing')
    const counter = (await pool.query('SELECT next_nonce FROM ac_playable_testnet_chain_nonces WHERE chain_instance=$1 AND account=$2', ['1301:' + manifest.genesisHash, treasuryAddress])).rows[0]
    assert(BigInt(counter.next_nonce) > BigInt(request.transaction.nonce))
    state.nonceBeforeSignVerified = true; state.signRequests++; await writeCheckpoint(statePath, state)
    return provider.signTransaction(request)
  } }
  const wallets = await createTestnetWallets({ pool, rootDirectory: root, environment: manifest.environment, chainId: 1301,
    rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, provider: signingProvider,
    allowedTargets: [binding.token], maxNativeBudgetWei: allocationCapWei, allowBroadcast: true })
  assert.equal((await wallets.getRoleWallet('treasury')).address, treasuryAddress)
  const balance = address => wallets.client.readContract({ address: binding.token, abi, functionName: 'balanceOf', args: [address] })
  if (!state.before) {
    state.before = { treasuryCITY: String(await balance(treasuryAddress)), recipientCITY: String(await balance(recipientAddress)),
      treasuryNativeWei: String(await wallets.client.getBalance({ address: treasuryAddress })), nonce: await wallets.client.getTransactionCount({ address: treasuryAddress, blockTag: 'pending' }) }
    assert(BigInt(state.before.treasuryCITY) >= amount)
    assert(BigInt(state.before.treasuryNativeWei) > 0n && BigInt(state.before.treasuryNativeWei) <= allocationCapWei)
    await writeCheckpoint(statePath, state)
  }
  const input = { role: 'treasury', operationId: state.operationId, to: binding.token, data: binding.data, value: 0n,
    limits: { maxGas: binding.maxGas, maxNativeCostWei: allocationCapWei } }
  const prepared = await wallets.prepare(input)
  const stored = (await pool.query('SELECT * FROM ac_playable_testnet_chain_intents WHERE operation_id=$1', [state.operationId])).rows[0]
  assert.equal(keccak256(stored.raw_transaction), prepared.hash)
  assert.equal(stored.destination, binding.token); assert.equal(stored.calldata, binding.data)
  assert.equal(state.nonceBeforeSignVerified, true)
  pass('actual Privy delegate signs only after durable bound nonce; exact signed bytes persist before broadcast')
  await wallets.broadcast({ role: 'treasury', operationId: state.operationId })
  await wallets.client.waitForTransactionReceipt({ hash: prepared.hash, confirmations: 2, timeout: 120000 })
  const result = await wallets.reconcile({ role: 'treasury', operationId: state.operationId })
  assert.equal(result.status, 'confirmed'); assert.equal(result.canonical, true)
  const receipt = await wallets.client.getTransactionReceipt({ hash: prepared.hash })
  const transaction = await wallets.client.getTransaction({ hash: prepared.hash })
  assert.equal(transaction.from.toLowerCase(), treasuryAddress); assert.equal(transaction.to.toLowerCase(), binding.token)
  assert.equal(transaction.input, binding.data); assert.equal(transaction.value, 0n)
  const transfers = receipt.logs.filter(log => log.address.toLowerCase() === binding.token).map(log => decodeEventLog({ abi, data: log.data, topics: log.topics }))
  assert.equal(transfers.length, 1)
  assert.equal(transfers[0].args.from.toLowerCase(), treasuryAddress); assert.equal(transfers[0].args.to.toLowerCase(), recipientAddress)
  assert.equal(transfers[0].args.value, amount)
  const after = { treasuryCITY: String(await balance(treasuryAddress)), recipientCITY: String(await balance(recipientAddress)),
    treasuryNativeWei: String(await wallets.client.getBalance({ address: treasuryAddress })), nonce: await wallets.client.getTransactionCount({ address: treasuryAddress, blockTag: 'pending' }) }
  assert.equal(BigInt(state.before.treasuryCITY) - BigInt(after.treasuryCITY), amount)
  assert.equal(BigInt(after.recipientCITY) - BigInt(state.before.recipientCITY), amount)
  assert.equal(after.nonce, state.before.nonce + 1)
  assert(BigInt(state.before.treasuryNativeWei) >= BigInt(after.treasuryNativeWei))
  assert(BigInt(state.before.treasuryNativeWei) - BigInt(after.treasuryNativeWei) <= allocationCapWei)
  pass('canonical ERC20 transfer calldata logs and exact 1CITY balance deltas match authorized treasury grant')
  const signRequests = state.signRequests
  assert.equal((await wallets.prepare(input)).hash, prepared.hash)
  await wallets.broadcast({ role: 'treasury', operationId: state.operationId })
  assert.equal((await wallets.reconcile({ role: 'treasury', operationId: state.operationId })).hash, prepared.hash)
  assert.equal(state.signRequests, signRequests)
  assert.equal(await wallets.client.getTransactionCount({ address: treasuryAddress, blockTag: 'pending' }), after.nonce)
  assert.equal(String(await balance(treasuryAddress)), after.treasuryCITY)
  assert.equal(String(await balance(recipientAddress)), after.recipientCITY)
  assert.equal((await json(join(directory, 'wallet-settings.json'))).allowBroadcast, false)
  pass('same operation replay signs zero additional requests and moves zero additional coins or nonce')
  state.confirmedHash = prepared.hash; await writeCheckpoint(statePath, state)
  Object.assign(report, { status: 'pass', transactionHash: prepared.hash, blockHash: receipt.blockHash, blockNumber: String(receipt.blockNumber),
    before: state.before, after, signRequests: state.signRequests, globalBroadcastEnabled: false, publicTransactions: 1 })
  await writeCheckpoint(reportPath, report)
  console.log(JSON.stringify({ status: 'pass', tests: report.tests.length, transactionHash: prepared.hash, evidence: reportPath, humanTradeClaimed: false }))
} catch (error) {
  report.error = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : (error.shortMessage || error.message).split('\n')[0].slice(0, 250)
  if (error.providerStatus || error.providerReason) Object.assign(report, { providerStatus: error.providerStatus, providerReason: error.providerReason })
  if (reportPath) await writeCheckpoint(reportPath, report)
  console.log(JSON.stringify({ status: 'fail', error: report.error, evidence: reportPath, originalOperationRetained: true }))
  process.exitCode = 1
} finally { if (pool) await pool.end(); await release() }
