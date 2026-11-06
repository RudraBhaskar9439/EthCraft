// Scoped signer refusal tests. No private key is opened, signed, or broadcast.
// Fixture bindings remain in the shared journal; assertions inspect only our IDs.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createBankOperatorWallets } from '../../backend/src/bank/operator-wallets.mjs'
import { loadBankAbis } from '../../backend/src/bank/abis.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url)), { Pool } = require('pg')
const { encodeFunctionData, zeroAddress } = require('viem')
const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID()
const output = join(root, 'evidence/runs/bank-operator-guards', runId)
await mkdir(output, { recursive: true })
const manifest = JSON.parse(await readFile(join(root, '.local/bank/public-deployment.json'), 'utf8'))
const settings = JSON.parse(await readFile(join(root, '.local/bank/operator-settings.json'), 'utf8'))
const database = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
const pool = new Pool({ connectionString: database.databaseUrl, max: 3 })
const report = { status: 'fail', runId, scope: 'Real PostgreSQL scoped signer refusals, plus read-only public code checks for immutable retained bindings.',
  publicTransactions: 0, privateKeysOpened: 0, signatures: 0, paidModelCalls: 0, realMoneySpentUsd: 0, checks: [], testOperationIds: [] }
const actualFetch = globalThis.fetch
let rpcReads = 0
globalThis.fetch = (...args) => { rpcReads++; return actualFetch(...args) }
const check = name => { report.checks.push({ name, status: 'pass' }); console.log(JSON.stringify({ check: name, status: 'pass' })) }
try {
  // Any unexpected fall-through fails before privateFile/openDevelopmentKeystore.
  // The actual on-disk operator configuration and keystores are never modified.
  const inaccessible = join(root, '.local/bank/nonexistent-guard-fixture-' + runId)
  for (const wallet of [...Object.values(settings.roles), ...Object.values(settings.actors).map(value => value.wallet)]) {
    wallet.keystore = inaccessible; wallet.passwordFile = inaccessible
  }
  const wallets = await createBankOperatorWallets({ rootDirectory: root, pool, manifest, settings })
  assert.equal(rpcReads, 0, 'Constructor must not sign or query the chain')
  const abis = await loadBankAbis(root), borrower = settings.actors.borrower, bidder = settings.actors.bidder
  assert.ok(borrower?.principalId && bidder?.principalId)
  const id = () => { const value = randomUUID(); report.testOperationIds.push(value); return value }
  const data = (target, functionName, args) => encodeFunctionData({ abi: abis[target], functionName, args })
  const request = (values = {}) => ({ playerId: borrower.principalId, operationId: id(), to: manifest.usdc,
    data: data('usdc', 'approve', [manifest.router, 1n]), value: 0n,
    limits: { maxGas: manifest.maxGas, maxNativeCostWei: manifest.maxNativeCostWei }, ...values })
  await assert.rejects(wallets.prepare(request({ playerId: randomUUID() })), /BANK_OPERATOR_KNOWN_ACTOR_REQUIRED/)
  await assert.rejects(wallets.prepare(request({ to: zeroAddress })), /BANK_OPERATOR_TARGET_DENIED/)
  check('unknown actor and unexpected contract target are denied before chain or key access')
  await assert.rejects(wallets.prepare(request({ data: data('usdc', 'mint', [borrower.wallet.address, 1n]) })), /BANK_OPERATOR_TOKEN_CALL_DENIED/)
  await assert.rejects(wallets.prepare(request({ to: manifest.registry, data: data('registry', 'mintItem', [borrower.wallet.address,
    manifest.serverId, '0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '0x' + '3'.repeat(64), '0x' + '4'.repeat(64)]) })), /BANK_OPERATOR_SELECTOR_DENIED/)
  check('player cannot mint payment tokens or native-backed NFTs')
  await assert.rejects(wallets.prepare(request({ data: data('usdc', 'approve', [manifest.registry, 1n]) })), /BANK_OPERATOR_APPROVAL_TARGET_DENIED/)
  await assert.rejects(wallets.prepare(request({ data: data('usdc', 'approve', [manifest.router, 100000001n]) })), /BANK_OPERATOR_APPROVAL_CAP/)
  await assert.rejects(wallets.prepare(request({ to: manifest.city, data: data('city', 'approve', [manifest.router, 100n * 10n ** 18n + 1n]) })), /BANK_OPERATOR_APPROVAL_CAP/)
  await assert.rejects(wallets.prepare(request({ to: manifest.registry, data: data('registry', 'approve', [manifest.router, 1n]) })), /BANK_OPERATOR_NFT_APPROVAL_DENIED/)
  check('token and NFT approvals enforce permitted spender and finite amount caps')
  await assert.rejects(wallets.prepare(request({ value: 1n })), /BANK_OPERATOR_BOUNDED_CALL_REQUIRED/)
  await assert.rejects(wallets.prepare(request({ limits: { maxGas: Number(manifest.maxGas) + 1, maxNativeCostWei: manifest.maxNativeCostWei } })), /BANK_OPERATOR_GAS_CAP_REQUIRED/)
  await assert.rejects(wallets.prepare(request({ limits: { maxGas: manifest.maxGas, maxNativeCostWei: String(BigInt(manifest.maxNativeCostWei) + 1n) } })), /BANK_OPERATOR_GAS_CAP_REQUIRED/)
  check('native value and per-call gas budget escapes are denied')
  const loanId = '0x' + '5'.repeat(64)
  await assert.rejects(wallets.role('registrar').prepare(request({ to: manifest.bank, data: data('bank', 'repay', [loanId]) })), /BANK_OPERATOR_SELECTOR_DENIED/)
  await assert.rejects(wallets.role('inspector').prepare(request({ to: manifest.market, data: data('market', 'cancel', [1n, 1n]) })), /BANK_OPERATOR_SELECTOR_DENIED/)
  await assert.rejects(wallets.role('publisher').prepare(request({ data: data('usdc', 'approve', [manifest.router, 1n]) })), /BANK_OPERATOR_TOKEN_CALL_DENIED/)
  assert.throws(() => wallets.role('administrator'), /BANK_OPERATOR_ROLE_DENIED/)
  const terms = { borrower: borrower.wallet.address, tokenId: 1n, ownershipNonce: 0n, revision: 0n, snapshotHash: '0x' + '6'.repeat(64),
    valuation: 10000000n, principal: 1000000n, repayment: 1010000n, term: 120, grace: 60,
    offerExpiry: Math.floor(Date.now() / 1000) + 3600, auctionDuration: 60, auctionReserve: 100000n }
  await assert.rejects(wallets.prepare(request({ to: manifest.bank, data: data('bank', 'offerLoan', [loanId, terms]) })), /BANK_OPERATOR_LENDER_REQUIRED/)
  check('registrar publisher inspector and lender privileges remain separated')
  const marketplace = await createBankOperatorWallets({ rootDirectory: root, pool,
    manifest: { ...manifest, mode: 'marketplace' }, settings })
  await assert.rejects(marketplace.prepare(request({ to: manifest.bank, data: data('bank', 'repay', [loanId]) })), /MARKETPLACE_TARGET_REQUIRED/)
  await assert.rejects(marketplace.prepare(request({ data: data('usdc', 'approve', [manifest.bank, 1n]) })), /MARKETPLACE_TARGET_REQUIRED/)
  await assert.rejects(marketplace.prepare(request({ to: manifest.city, data: data('city', 'approve', [manifest.bank, 1n]) })), /MARKETPLACE_TARGET_REQUIRED/)
  await assert.rejects(marketplace.prepare(request({ to: manifest.registry, data: data('registry', 'approve', [manifest.bank, 1n]) })), /MARKETPLACE_TARGET_REQUIRED/)
  await assert.rejects(marketplace.prepare(request({ to: manifest.gem, data: data('gem', 'approve', [manifest.router, 1n]) })), /MARKETPLACE_TARGET_REQUIRED/)
  check('marketplace signer refuses lending, bank token/NFT approvals and GEM before RPC or key access')
  const retainedBank = request({ to: manifest.bank, data: data('bank', 'repay', [loanId]) })
  const retainedBankBinding = { owner: borrower.principalId, account: borrower.wallet.address.toLowerCase(), target: 'bank',
    to: manifest.bank.toLowerCase(), data: retainedBank.data.toLowerCase(), value: '0', maxGas: Number(manifest.maxGas), maxNativeCostWei: manifest.maxNativeCostWei }
  await pool.query(`INSERT INTO ${manifest.journalSchema}.bank_operator_bindings(operation_id,binding) VALUES($1,$2)`, [retainedBank.operationId, retainedBankBinding])
  for (const method of ['broadcast', 'reconcile']) await assert.rejects(marketplace[method]({ playerId: borrower.principalId,
    operationId: retainedBank.operationId }), /MARKETPLACE_TARGET_REQUIRED/)
  check('marketplace refuses historical bank broadcast and reconciliation before RPC or key access')
  const guardRpcReads = rpcReads
  assert.equal(guardRpcReads, 0, 'Every invalid guard request must fail before the first RPC')
  const original = request(), binding = { owner: borrower.principalId, account: borrower.wallet.address.toLowerCase(), target: 'usdc',
    to: manifest.usdc.toLowerCase(), data: original.data.toLowerCase(), value: '0', maxGas: Number(manifest.maxGas), maxNativeCostWei: manifest.maxNativeCostWei }
  await pool.query(`INSERT INTO ${manifest.journalSchema}.bank_operator_bindings(operation_id,binding) VALUES($1,$2)`, [original.operationId, binding])
  await assert.rejects(wallets.reconcile({ playerId: bidder.principalId, operationId: original.operationId }), /BANK_OPERATOR_RETAINED_OWNER_REQUIRED/)
  assert.equal(rpcReads, 0)
  await assert.rejects(wallets.prepare({ ...original, data: data('usdc', 'approve', [manifest.router, 2n]) }), /BANK_OPERATOR_IMMUTABLE_INTENT_REQUIRED/)
  assert.ok(rpcReads > 0, 'Immutability path verifies only public chain identity and code')
  check('retained intent rejects changed owner and calldata before key access')
  const supported = ['city', 'usdc'].map(target => request({ to: manifest[target], data: data(target, 'approve', [manifest.router, 1n]) }))
  for (const input of supported) await assert.rejects(marketplace.prepare(input), /ENOENT/)
  check('marketplace permits bounded CITY and USDC router approvals up to the deliberately inaccessible key boundary')
  const intents = await pool.query(`SELECT operation_id FROM ${manifest.journalSchema}.ac_chain_intents WHERE operation_id=ANY($1::uuid[])`, [report.testOperationIds])
  assert.equal(intents.rowCount, 0)
  const bindings = await pool.query(`SELECT operation_id FROM ${manifest.journalSchema}.bank_operator_bindings WHERE operation_id=ANY($1::uuid[])`, [report.testOperationIds])
  assert.deepEqual(bindings.rows.map(value => value.operation_id).sort(), [original.operationId, retainedBank.operationId, ...supported.map(value => value.operationId)].sort())
  check('all test operations produced zero signed intents and only the four deliberately retained fixture bindings')
  report.status = 'pass'; report.invalidGuardRpcCalls = guardRpcReads; report.readOnlyRpcCalls = rpcReads
  report.sourceHashes = Object.fromEntries(await Promise.all(['backend/src/bank/operator-wallets.mjs', 'tests/bank/operator-wallets.mjs']
    .map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
} catch (error) { report.error = { name: error.name, message: error.shortMessage || error.message }; process.exitCode = 1 }
finally {
  globalThis.fetch = actualFetch; await pool.end()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(output, 'report.json'), error: report.error }))
}
