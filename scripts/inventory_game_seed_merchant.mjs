import { readFile, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { PublicTestnetEvm } from '../backend/src/chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'
import { createBankRpcClient } from '../backend/src/bank/rpc.mjs'
import { digest, json, lower } from '../backend/src/world-assets/canonical.mjs'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { keccak256, stringToHex, parseTransaction } = require('viem')
const root = fileURLToPath(new URL('../', import.meta.url))
const amount = 1200000000000000n, gasCap = 30000n, feeCap = 30000000000000n, originalCap = 4000000000000000n
const userWallet = '0xd1dcaaff9356d5a42f2ee6f90179c4509386a83f'
const journalSchema = 'bank_deployment_1301_9e0144797c4a'
const fail = code => { throw Error(code) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function inventoryGameSeedTerms({ manifest, original, originalManifestSha256, source, developerAddress, recipient }) {
  if (manifest?.mode !== 'marketplace' || manifest.environment !== 'UNICHAIN_SEPOLIA_BANK' || manifest.chainId !== 1301 ||
      manifest.rpcUrl !== 'https://sepolia.unichain.org' || manifest.journalSchema !== journalSchema ||
      String(manifest.maximumNativeBudgetWei) !== String(originalCap) ||
      !/^0x[a-f0-9]{64}$/i.test(manifest.deploymentId || '') || !/^0x[a-f0-9]{64}$/i.test(manifest.serverId || '') ||
      !/^0x[a-f0-9]{64}$/i.test(manifest.genesisHash || '') ||
      ['chainId', 'rpcUrl', 'genesisHash', 'journalSchema', 'maximumNativeBudgetWei', 'serverId'].some(key => manifest[key] !== original?.[key]) ||
      manifest.historicalDeployment?.deploymentId !== original.deploymentId || manifest.historicalDeployment?.manifestSha256 !== originalManifestSha256 ||
      manifest.historicalDeployment?.manifestUnchanged !== true) fail('INVENTORY_GAME_SEED_ORIGINAL_JOURNAL_REQUIRED')
  source = lower(source); recipient = lower(recipient)
  if (source !== lower(developerAddress) || source === userWallet || recipient === userWallet || source === recipient ||
      /^0x0{40}$/.test(source) || /^0x0{40}$/.test(recipient)) fail('INVENTORY_GAME_SEED_SOURCE_OR_RECIPIENT_REQUIRED')
  const purpose = 'privy-game-starter-source-seed-v1'
  const h = keccak256(stringToHex([purpose, manifest.deploymentId, manifest.serverId, source, recipient, String(amount)].join(':'))).slice(2, 34)
  return { operationId: [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-'), purpose,
    chainId: 1301, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash, journalSchema,
    maximumNativeBudgetWei: String(originalCap), source, recipient, valueWei: String(amount), data: '0x',
    maximumGas: String(gasCap), maximumExecutionFeeWei: String(feeCap), originalManifestSha256 }
}

export function validateInventoryGameSeedTransaction(terms, transaction) {
  const gas = BigInt(transaction.gas || 0), fee = BigInt(transaction.maxFeePerGas ?? transaction.gasPrice ?? 0)
  if (Number(transaction.chainId) !== terms.chainId || lower(transaction.to) !== terms.recipient ||
      transaction.from && lower(transaction.from) !== terms.source || (transaction.data || '0x') !== '0x' ||
      BigInt(transaction.value || 0) !== BigInt(terms.valueWei) || gas < 21000n || gas > gasCap || fee <= 0n || gas * fee > feeCap) fail('INVENTORY_GAME_SEED_EXACT_TRANSACTION_REQUIRED')
}

async function privateFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('INVENTORY_GAME_SEED_PRIVATE_KEY_FILES_REQUIRED')
}

async function main() {
  const apply = process.argv.length === 3 && process.argv[2] === '--apply'
  if (process.argv.length !== 2 && !apply) fail('INVENTORY_GAME_SEED_USE_PREFLIGHT_OR_APPLY')
  const manifest = JSON.parse(await readFile(join(root, '.local/marketplace/public-deployment.json'), 'utf8'))
  const originalBytes = await readFile(join(root, '.local/bank/public-deployment.json')), original = JSON.parse(originalBytes)
  const settings = JSON.parse(await readFile(join(root, '.local/bank/operator-settings.json'), 'utf8'))
  const developer = JSON.parse(await readFile(join(root, '.local/public-testnet/account-settings.json'), 'utf8'))
  const seller = settings.actors?.seller, administrator = settings.roles?.administrator
  if (settings.operatorControlled !== true || settings.chainId !== 1301 || seller?.operatorControlled !== true || seller.role !== 'seller' || seller.minecraftUsername !== 'BankSeller' ||
      administrator?.keystore !== developer.keystore || administrator.passwordFile !== developer.passwordFile ||
      ['registrar', 'liquidity', 'publisher', 'inspector'].some(role => lower(settings.roles[role].address) === lower(administrator.address))) fail('INVENTORY_GAME_SEED_CONTROLLED_OPS_SOURCE_REQUIRED')
  const terms = inventoryGameSeedTerms({ manifest, original, originalManifestSha256: sha(originalBytes), source: administrator.address,
    developerAddress: developer.address, recipient: seller.wallet.address })
  for (const file of [developer.keystore, developer.passwordFile]) await privateFile(file)
  const keystore = JSON.parse(await readFile(developer.keystore, 'utf8'))
  if (keystore.version !== 3 || typeof keystore.crypto?.ciphertext !== 'string') fail('INVENTORY_GAME_SEED_ENCRYPTED_KEYSTORE_REQUIRED')
  if (keystore.address !== undefined && lower('0x' + String(keystore.address).replace(/^0x/, '')) !== terms.source) fail('INVENTORY_GAME_SEED_DEVELOPER_KEY_ADDRESS_CHANGED')
  const environment = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  const url = new URL(environment.databaseUrl); url.searchParams.set('options', '-c search_path=' + journalSchema)
  const store = new PostgresStore(url.toString()), client = await createBankRpcClient(manifest)
  const release = apply ? await checkpoints.acquireLocalLease('agentcity-inventory-game-seed-merchant') : null
  try {
    if (await client.getChainId() !== 1301 || (await client.getBlock({ blockNumber: 0n })).hash.toLowerCase() !== terms.genesisHash.toLowerCase()) fail('INVENTORY_GAME_SEED_CHAIN_CHANGED')
    const rows = (await store.query('SELECT * FROM ac_chain_intents WHERE chain_instance=$1', ['1301:' + terms.genesisHash])).rows
    const existing = rows.find(row => row.operation_id === terms.operationId)
    if (existing) {
      if (existing.account !== terms.source || existing.destination !== terms.recipient || existing.calldata !== terms.data) fail('INVENTORY_GAME_SEED_ORIGINAL_TRANSACTION_CHANGED')
      validateInventoryGameSeedTransaction(terms, parseTransaction(existing.raw_transaction))
    }
    for (const schema of [journalSchema, 'public_testnet_1301']) {
      const found = (await store.query('SELECT to_regclass($1) IS NOT NULL AS present', [schema + '.ac_chain_intents'])).rows[0].present
      if (!found) continue
      const pending = await store.query(`SELECT 1 FROM ${schema}.ac_chain_intents WHERE chain_instance=$1 AND lower(account)=$2
        AND operation_id<>$3 AND status NOT IN ('confirmed','reverted') LIMIT 1`, ['1301:' + terms.genesisHash, terms.source, terms.operationId])
      if (pending.rowCount) fail('INVENTORY_GAME_SEED_DEVELOPER_PENDING_INTENT')
    }
    const reserved = rows.reduce((sum, row) => { const tx = parseTransaction(row.raw_transaction); return sum + BigInt(tx.value || 0) + BigInt(tx.gas) * BigInt(tx.maxFeePerGas ?? tx.gasPrice) }, 0n)
    if (reserved + (existing ? 0n : amount + feeCap) > originalCap) fail('INVENTORY_GAME_SEED_ORIGINAL_BUDGET_EXHAUSTED')
    const balance = await client.getBalance({ address: terms.source })
    if (!existing) {
      const [gas, fees] = await Promise.all([client.estimateGas({ account: terms.source, to: terms.recipient, data: '0x', value: amount }), client.estimateFeesPerGas()])
      validateInventoryGameSeedTransaction(terms, { chainId: 1301, from: terms.source, to: terms.recipient, data: '0x', value: amount, gas, ...fees })
      if (balance < amount + feeCap) fail('INVENTORY_GAME_SEED_DEVELOPER_BALANCE_REQUIRED')
    }
    if (!apply) {
      console.log(JSON.stringify({ status: 'ready', applied: false, terms, existingIntentStatus: existing?.status || null,
        reservedMaximumWei: String(reserved), remainingWorstCaseBudgetWei: String(originalCap - reserved), sourceBalanceWei: String(balance),
        sourceKeyOpened: false, encryptedAddressPresent: keystore.address !== undefined, decryptedAddressCheckedOnApply: true, signatures: 0, publicTransactions: 0 }))
      return
    }
    const progressFile = join(root, '.local/mumbai-city/merchant-seed.json')
    let progress = await checkpoints.readCheckpoint(progressFile)
    if (progress && progress.termsDigest !== digest(terms)) fail('INVENTORY_GAME_SEED_PROGRESS_BINDING_CHANGED')
    progress ||= { schema: 'agentcity.inventory-game-merchant-seed.v1', terms, termsDigest: digest(terms), createdAt: new Date().toISOString(), status: 'intent' }
    await checkpoints.writeCheckpoint(progressFile, progress)
    const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: terms.rpcUrl, genesisHash: terms.genesisHash,
      environment: 'PUBLIC_TESTNET_WORLD_ASSETS', allowedSigners: [terms.source] })
    evm.nativeCap = originalCap
    const validate = evm.validateRequest.bind(evm)
    evm.validateRequest = async (tx, request) => { validateInventoryGameSeedTransaction(terms, request); await validate(tx, request) }
    if (!existing) {
      const signer = await openDevelopmentKeystore(developer)
      if (lower(signer.address) !== terms.source) fail('INVENTORY_GAME_SEED_DEVELOPER_KEY_ADDRESS_CHANGED')
      await evm.prepare(terms.operationId, signer, terms.recipient, '0x', amount)
    }
    const retained = (await store.query('SELECT transaction_hash FROM ac_chain_intents WHERE operation_id=$1', [terms.operationId])).rows[0]
    if (!retained || progress.transactionHash && progress.transactionHash !== retained.transaction_hash) fail('INVENTORY_GAME_SEED_ORIGINAL_TRANSACTION_CHANGED')
    progress.transactionHash = retained.transaction_hash; progress.status = 'prepared'; await checkpoints.writeCheckpoint(progressFile, progress)
    await evm.broadcast(terms.operationId)
    const result = await evm.receipt(terms.operationId, 2)
    progress.status = result.status; progress.result = json(result); await checkpoints.writeCheckpoint(progressFile, progress)
    const report = { schema: 'agentcity.inventory-game-merchant-seed-receipt.v1', status: result.status, recordedAt: new Date().toISOString(),
      scope: 'One-time controlled developer operations seed to the existing merchant. This is not a customer grant or purchase authorization.',
      terms, transactionHash: retained.transaction_hash, receipt: result.status === 'confirmed' ? { blockNumber: String(result.receipt.blockNumber), blockHash: result.receipt.blockHash, confirmations: 2 } : null,
      originalNonceJournalPreserved: true, cumulativeBudgetUnchanged: true, earlierSeedIntentsUnchanged: true, userWalletsTouched: false, liquidityTouched: false }
    const evidence = join(root, 'evidence/runs/inventory-game-privy', randomUUID(), 'merchant-source-seed.json')
    await checkpoints.writeCheckpoint(evidence, report)
    console.log(JSON.stringify({ status: result.status, operationId: terms.operationId, transactionHash: retained.transaction_hash, evidence,
      scope: report.scope, nativeAmountWei: String(amount), replacementTransfers: 0 }))
    if (result.status === 'reverted') process.exitCode = 1
  } finally { await store.close(); await release?.() }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'INVENTORY_GAME_SEED_UNAVAILABLE',
    httpStatus: Number.isInteger(error.status) ? error.status : null, replacementTransfers: 0 }))
  process.exitCode = 1
})
