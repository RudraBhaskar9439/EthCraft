import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createAgreementService, prepareAgreement, agreementTypedData } from '../../backend/src/agreements/service.mjs'
import { createExternalWalletService } from '../../backend/src/chain/external-wallet.mjs'
import { INSPECTION_TYPES } from '../../backend/src/inspection/coordinator.mjs'
import { destinationHash } from '../../backend/src/procurement/service.mjs'

// Mocked public-chain observations and ephemeral signatures; only the isolated local database is real.
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, zeroHash } = require('viem')
const root = new URL('../../', import.meta.url)
const hash = value => keccak256(stringToHex(value))
const accounts = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()))
const [requester, builder, attestor, stranger] = accounts
const fixtureAddress = number => '0x' + number.toString(16).padStart(40, '0')
const deployment = { chainId: 1301, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', rpcUrl: 'https://sepolia.unichain.org',
  genesisHash: hash('external-wallet-fixture-genesis'), creditToken: fixtureAddress(1), jobEscrow: fixtureAddress(2),
  procurement: fixtureAddress(3), kitCustody: fixtureAddress(4), stateRegistry: fixtureAddress(5),
  attestor: attestor.address, serverId: hash('external-wallet-synthetic-server'), bundleHash: hash('synthetic-six-material-bundle') }
const abi = Object.fromEntries(await Promise.all(['CreditToken', 'JobEscrow', 'Procurement', 'KitCustody'].map(async name =>
  [name, JSON.parse(await readFile(new URL(`contracts/abi/${name}.json`, root), 'utf8'))])))
const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
assert.equal(new URL(settings.databaseUrl).hostname, '127.0.0.1')
const schema = 'external_wallet_fixture_' + randomUUID().replaceAll('-', '')
const administrator = new PostgresStore(settings.databaseUrl)
const databaseUrl = new URL(settings.databaseUrl)
databaseUrl.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(databaseUrl.toString())
let chainTime = BigInt(Math.floor(Date.now() / 1000)), head = 100n
let nonceRaceWallet = null, nonceRaceReads = 0
let latestNonceOverride = null, pendingNonceOverride = null
const nonce = new Map(), jobs = new Map(), allowances = new Map(), allocations = new Map(), extras = new Map()
const transactions = new Map(), receipts = new Map(), canonicalBlocks = new Map()
const lower = value => value.toLowerCase()
const allowanceKey = (owner, spender) => lower(owner) + ':' + lower(spender)
const allocationKey = (job, owner) => job + ':' + lower(owner)
const blockHash = number => canonicalBlocks.get(number.toString()) || hash('canonical-block-' + number)
const missing = name => { const error = new Error('mocked observation unavailable'); error.name = name; throw error }
const client = {
  chain: { id: 1301 },
  getChainId: async () => 1301,
  getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? head, timestamp: chainTime,
    hash: blockNumber === 0n ? deployment.genesisHash : blockHash(blockNumber ?? head) }),
  getBlockNumber: async () => head,
  getTransactionCount: async ({ address, blockTag }) => {
    const current = nonce.get(lower(address)) || 0
    const override = blockTag === 'latest' ? latestNonceOverride : pendingNonceOverride
    if (lower(address) === lower(requester.address) && override !== null) return override
    return lower(address) === nonceRaceWallet && ++nonceRaceReads > 1 ? current + 1 : current
  },
  getBalance: async () => 10n ** 18n,
  estimateGas: async () => 100000n,
  estimateFeesPerGas: async () => ({ maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n }),
  getTransaction: async ({ hash: id }) => transactions.get(id) || missing('TransactionNotFoundError'),
  getTransactionReceipt: async ({ hash: id }) => receipts.get(id) || missing('TransactionReceiptNotFoundError'),
  readContract: async ({ functionName, args = [] }) => {
    if (functionName === 'status') return jobs.get(args[0]) || [zeroHash, 0n, false, false]
    if (functionName === 'allowance') return allowances.get(allowanceKey(...args)) || 0n
    if (functionName === 'allocations') return allocations.get(allocationKey(...args)) || 0n
    if (functionName === 'backed' || functionName === 'available') return true
    if (functionName === 'invalidReports') return false
    throw new Error('Unexpected mocked read: ' + functionName)
  }
}
assert.equal('sendTransaction' in client || 'sendRawTransaction' in client, false)
const checks = []
const check = name => { checks.push(name); console.log('PASS fixture: ' + name) }
let service
const agreements = createAgreementService({ store, clock: () => Number(chainTime * 1000n),
  context: { domain: { chainId: 1301, verifyingContract: deployment.jobEscrow }, ...deployment,
    cred: deployment.creditToken, kit: deployment.kitCustody, blueprintHash: hash('synthetic-blueprint'),
    testsHash: hash('synthetic-tests'), accessHash: hash('synthetic-access') },
  verifyFunding: async ({ record, evidence }) => {
    const row = (await store.query('SELECT * FROM external_wallet_intents WHERE operation_id=$1', [evidence.operationId])).rows[0]
    return row?.action === 'fund' && row.agreement_hash === record.hash && row.status === 'confirmed' && row.canonical && row.confirmations >= 2
  } })

async function agreement(label) {
  const prepared = prepareAgreement({ domain: { chainId: 1301, verifyingContract: deployment.jobEscrow },
    terms: { jobId: hash(label + randomUUID()), serverId: deployment.serverId, version: '1', requester: requester.address,
      builder: builder.address, cred: deployment.creditToken, kit: deployment.kitCustody, bundleHash: deployment.bundleHash,
      blueprintHash: hash('synthetic-blueprint'), testsHash: hash('synthetic-tests'), accessHash: hash('synthetic-access'),
      materialCap: '3000000000000000000', workDeadline: String(chainTime + 3600n), reviewDeadline: String(chainTime + 4500n),
      passDeadline: String(chainTime + 4500n), absoluteExpiry: String(chainTime + 4500n) },
    scope: { worldId: 'synthetic-human-demo-fixture-' + label, plotMin: [-16, 80, -8], plotMax: [15, 95, 7],
      blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5], orientation: 'identity', startAt: String(chainTime),
      approvalExpiresAtMs: String((chainTime + 900n) * 1000n), ownershipPolicyHash: hash('synthetic-ownership'),
      refundPolicyHash: hash('synthetic-refund'), inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '8000000000000000' },
    allocations: [{ recipient: builder.address, amount: '6000000000000000000' }] })
  const { scopeHash, allocationsHash, ...terms } = prepared.terms
  await agreements.create({ terms, scope: prepared.scope, allocations: prepared.allocations }, requester.address)
  for (const account of [requester, builder]) await agreements.approve(prepared.hash, account.address, await account.signTypedData(agreementTypedData(prepared)))
  extras.set(prepared.hash, {})
  return agreements.get(prepared.hash)
}

const prepare = (record, action, actor = requester, operationId = randomUUID()) => service.prepare({ operationId, agreementHash: record.hash, action }, actor.address)
function decoded(intent, name) { return decodeFunctionData({ abi: abi[name], data: intent.request.data }) }
function event(name, eventName, args, address) {
  const entry = abi[name].find(value => value.type === 'event' && value.name === eventName)
  const plain = entry.inputs.filter(input => !input.indexed)
  return { address, topics: encodeEventTopics({ abi: abi[name], eventName, args }), data: encodeAbiParameters(plain, plain.map(input => args[input.name])), removed: false }
}
function mine(intent, logs, confirmations = 2) {
  const request = intent.request
  assert.ok(request, 'Prepared intent must expose its immutable request before a wallet prompt')
  const transactionHash = hash('fixture-transaction-' + intent.operationId), blockNumber = head + 1n
  head = blockNumber + BigInt(confirmations) - 1n; chainTime += 1n
  transactions.set(transactionHash, { hash: transactionHash, chainId: 1301, from: request.from, to: request.to,
    input: request.data, value: BigInt(request.value), nonce: Number(BigInt(request.nonce)), gas: BigInt(request.gas),
    maxFeePerGas: BigInt(request.maxFeePerGas), maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas) })
  const receipt = { transactionHash, from: request.from, to: request.to, blockNumber, blockHash: blockHash(blockNumber),
    status: 'success', gasUsed: 100000n, effectiveGasPrice: 1000000000n,
    logs: logs.map((log, index) => ({ ...log, transactionHash, blockNumber, blockHash: blockHash(blockNumber), logIndex: index, transactionIndex: 0 })) }
  receipts.set(transactionHash, receipt)
  nonce.set(request.from, Number(BigInt(request.nonce)) + 1)
  return transactionHash
}
async function confirm(intent, logs, actor = requester, confirmations = 2) {
  const txHash = mine(intent, logs, confirmations)
  return service.recordSubmittedHash(intent.operationId, txHash, actor.address)
}
async function fund(record) {
  const approved = await prepare(record, 'approve_escrow')
  assert.equal(approved.request.to, deployment.creditToken)
  assert.deepEqual(decoded(approved, 'CreditToken'), { functionName: 'approve', args: [deployment.jobEscrow, 6000000000000000000n] })
  assert.equal(approved.request.value, '0x0')
  assert.equal(approved.request.chainId, 1301)
  assert.equal(approved.deadlineMs, Number(approved.deadline) * 1000)
  assert.equal(approved.nativeBudgetWei, '8000000000000000')
  assert.equal(approved.summary.nativeBudgetWei, approved.nativeBudgetWei)
  assert.equal(BigInt(approved.request.gas), 120000n)
  const oneConfirmation = await confirm(approved, [event('CreditToken', 'Approval', { owner: requester.address, spender: deployment.jobEscrow, value: 6000000000000000000n }, deployment.creditToken)], requester, 1)
  assert.equal(oneConfirmation.status, 'confirming'); assert.equal(oneConfirmation.canonical, false)
  head += 1n
  assert.equal((await service.reconcile(approved.operationId, requester.address)).status, 'confirmed')
  allowances.set(allowanceKey(requester.address, deployment.jobEscrow), 6000000000000000000n)
  const funding = await prepare(record, 'fund')
  assert.equal(funding.summary.amount, '6000000000000000000')
  const call = decoded(funding, 'JobEscrow')
  assert.equal(call.functionName, 'fund'); assert.equal(call.args[0].jobId, record.terms.jobId)
  assert.deepEqual(call.args[1].map(lower), [lower(builder.address)]); assert.deepEqual(call.args[2], [6000000000000000000n])
  const confirmed = await confirm(funding, [event('JobEscrow', 'Funded', { jobId: record.terms.jobId, agreementHash: record.hash, requester: requester.address, total: 6000000000000000000n }, deployment.jobEscrow)])
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.confirmations, 2); assert.equal(confirmed.canonical, true)
  jobs.set(record.terms.jobId, [record.hash, 6000000000000000000n, false, false])
  allocations.set(allocationKey(record.terms.jobId, builder.address), 6000000000000000000n)
  allowances.set(allowanceKey(requester.address, deployment.jobEscrow), 0n)
  return agreements.freezeFunded(record.hash, { operationId: funding.operationId, fixture: 'mocked-canonical-chain-only' })
}

try {
  await administrator.query('CREATE SCHEMA ' + schema)
  await store.migrate(['backend/src/agreements/schema.sql', 'backend/src/chain/external-wallet.sql'].map(path => new URL(path, root)))
  await store.query('CREATE TABLE fixture_pending_acceptance(agreement_hash text PRIMARY KEY,operation_id uuid NOT NULL)')
  service = createExternalWalletService({ store, client, deployment, clock: () => Number(chainTime * 1000n),
    resolveContext: async ({ agreementHash, tx }) => {
      const row = (await tx.query('SELECT * FROM agreement_records WHERE agreement_hash=$1', [agreementHash])).rows[0]
      if (!row) return null
      const approvals = (await tx.query('SELECT signer,signature FROM agreement_approvals WHERE agreement_hash=$1', [agreementHash])).rows
      return { agreement: { hash: row.agreement_hash, domain: row.domain, terms: row.terms, scope: row.scope,
        allocations: row.allocations, requiredSigners: row.required_signers, approvals, state: row.state }, ...extras.get(agreementHash) }
    },
    onPrepared: async ({ agreementHash, action, operationId, tx, intent }) => {
      const persisted = (await tx.query('SELECT * FROM external_wallet_intents WHERE operation_id=$1', [operationId])).rows[0]
      assert.equal(persisted.status, 'prepared'); assert.deepEqual(persisted.request, intent.request)
      if (action === 'accept') await tx.query('INSERT INTO fixture_pending_acceptance VALUES($1,$2)', [agreementHash, operationId])
    } })
  assert.equal(await service.get(randomUUID(), requester.address), null)
  let record = await agreement('happy')
  await assert.rejects(prepare(record, 'approve_escrow', stranger), { code: 'EXTERNAL_ACTION_ROLE' })
  record = await fund(record)
  check('approved real EIP712 signatures, exact approve/fund encoding, requester authority and two canonical confirmations')
  const approval = await prepare(record, 'approve_procurement')
  assert.deepEqual(decoded(approval, 'CreditToken'), { functionName: 'approve', args: [deployment.procurement, 3000000000000000000n] })
  assert.equal((await confirm(approval, [event('CreditToken', 'Approval', { owner: requester.address, spender: deployment.procurement, value: 3000000000000000000n }, deployment.creditToken)])).status, 'confirmed')
  allowances.set(allowanceKey(requester.address, deployment.procurement), 3000000000000000000n)
  extras.set(record.hash, { quote: { kits: '1', maxCred: '2000000000000000000', deadline: String(chainTime + 60n) } })
  const purchase = await prepare(record, 'buy'), destination = destinationHash(record), claimId = hash('fixture-kit-claim')
  assert.equal(purchase.summary.kits, '1')
  assert.deepEqual(decoded(purchase, 'Procurement'), { functionName: 'buyAndRedeem', args: [record.terms.jobId, 1n, 2000000000000000000n, chainTime + 60n, destination] })
  const bought = await confirm(purchase, [event('Procurement', 'Purchased', { jobId: record.terms.jobId, claimId, requester: requester.address, kits: 1n, spentCred: 1100000000000000000n }, deployment.procurement),
    event('KitCustody', 'ClaimCreated', { claimId, jobId: record.terms.jobId, recipient: requester.address, kits: 1n, destinationHash: destination }, deployment.kitCustody)])
  assert.equal(bought.evidence.claimId, claimId); assert.equal(bought.evidence.spentCred, '1100000000000000000')
  await assert.rejects(prepare(record, 'buy'), { code: 'EXTERNAL_SEMANTIC_OPERATION_EXISTS' })
  check('exact whole-KIT quote/cap/destination and paired real-ABI purchase/claim events; no second semantic purchase')
  const inspection = { jobId: record.terms.jobId, agreementHash: record.hash, blueprintHash: record.terms.blueprintHash, testsHash: record.terms.testsHash,
    reportHash: hash('scripted-synthetic-sixteen-case-report'), lockHash: hash('synthetic-lock'), revision: '144', completedAt: String(chainTime),
    validUntil: String(chainTime + 300n), passed: true, casesPassed: 16, casesTotal: 16 }
  extras.get(record.hash).inspection = { report: inspection, signature: await attestor.signTypedData({ domain: record.domain, types: INSPECTION_TYPES, primaryType: 'Inspection', message: inspection }), protected: true }
  await assert.rejects(prepare(record, 'accept', builder), { code: 'EXTERNAL_ACTION_ROLE' })
  const acceptance = await prepare(record, 'accept')
  assert.equal(decoded(acceptance, 'JobEscrow').functionName, 'accept')
  assert.equal((await store.query('SELECT operation_id FROM fixture_pending_acceptance WHERE agreement_hash=$1', [record.hash])).rows[0].operation_id, acceptance.operationId)
  assert.equal((await confirm(acceptance, [event('JobEscrow', 'Accepted', { jobId: record.terms.jobId, reportHash: inspection.reportHash, revision: 144n }, deployment.jobEscrow)])).status, 'confirmed')
  jobs.get(record.terms.jobId)[2] = true
  const claim = await prepare(record, 'claim', builder)
  assert.deepEqual(decoded(claim, 'JobEscrow'), { functionName: 'claim', args: [record.terms.jobId] })
  assert.equal((await confirm(claim, [event('JobEscrow', 'Claimed', { jobId: record.terms.jobId, recipient: builder.address, amount: 6000000000000000000n }, deployment.jobEscrow)], builder)).status, 'confirmed')
  allocations.set(allocationKey(record.terms.jobId, builder.address), 0n)
  await assert.rejects(prepare(record, 'refund'), { code: 'EXTERNAL_REFUND_NOT_AVAILABLE' })
  check('protected EIP712 inspection, durable pending acceptance before prompt, exact requester acceptance and builder pull claim')
  await assert.rejects(store.query("UPDATE external_wallet_intents SET calldata='0x' WHERE operation_id=$1", [purchase.operationId]), /EXTERNAL_WALLET_INTENT_IMMUTABLE/)
  await assert.rejects(service.get(purchase.operationId, stranger.address), { code: 'EXTERNAL_INTENT_AUTHORITY' })
  check('PostgreSQL immutable intents and actor-bound reads')

  const lost = await fund(await agreement('lost-reply'))
  extras.set(lost.hash, { quote: { kits: '1', maxCred: '2000000000000000000', deadline: String(chainTime + 60n) } })
  const unknown = await prepare(lost, 'buy')
  assert.equal((await service.recordSubmittedHash(unknown.operationId, null, requester.address)).status, 'unknown')
  const retained = await service.get(unknown.operationId, requester.address)
  assert.equal(retained.nonce, unknown.nonce); assert.equal(retained.request, null)
  await assert.rejects(prepare(lost, 'buy'), { code: 'EXTERNAL_SEMANTIC_OPERATION_EXISTS' })
  await assert.rejects(prepare(lost, 'approve_procurement'), { code: 'EXTERNAL_SENDER_RECONCILIATION_REQUIRED' })
  const reserved = (await store.query('SELECT max_cred,native_reserved,nonce,request FROM external_wallet_intents WHERE operation_id=$1', [unknown.operationId])).rows[0]
  assert.equal(reserved.max_cred, '2000000000000000000'); assert.equal(String(reserved.nonce), unknown.nonce); assert.deepEqual(reserved.request, unknown.request)
  assert.equal((await service.prepare({ operationId: unknown.operationId, agreementHash: lost.hash, action: 'buy' }, requester.address)).nonce, unknown.nonce)
  check('lost wallet hash keeps original nonce/request/material/native reservation and blocks a fresh purchase or payment')
  // Resolve the same retained operation as a canonical revert before testing another independent action.
  const revertedHash = mine(unknown, []); receipts.get(revertedHash).status = 'reverted'
  assert.equal((await service.recordSubmittedHash(unknown.operationId, revertedHash, requester.address)).status, 'reverted')

  const mismatchRecord = await agreement('mismatch')
  const mismatch = await prepare(mismatchRecord, 'approve_escrow'), mismatchHash = mine(mismatch, [])
  transactions.get(mismatchHash).to = deployment.procurement
  await assert.rejects(service.recordSubmittedHash(mismatch.operationId, mismatchHash, requester.address), { code: 'EXTERNAL_TRANSACTION_MISMATCH' })
  assert.equal((await service.get(mismatch.operationId, requester.address)).status, 'reconciliation_required')
  await assert.rejects(prepare(mismatchRecord, 'approve_escrow'), { code: 'EXTERNAL_RECONCILIATION_REQUIRED' })
  check('mismatched wallet transaction fails closed and prevents a replacement prompt')

  // A confirmed allocation cannot be claimed again.
  const reorg = await prepare(record, 'claim', builder).catch(error => { assert.equal(error.code, 'EXTERNAL_CLAIM_NOT_AVAILABLE'); return null })
  assert.equal(reorg, null)
  const reorgRecord = await agreement('noncanonical')
  // A corrected RPC observation reconciles the original hash; it never creates another wallet intent.
  const row = (await store.query('SELECT * FROM external_wallet_intents WHERE operation_id=$1', [mismatch.operationId])).rows[0]
  transactions.set(mismatchHash, { ...transactions.get(mismatchHash), to: row.destination })
  const fee = transactions.get(mismatchHash).maxPriorityFeePerGas
  delete transactions.get(mismatchHash).maxPriorityFeePerGas
  await assert.rejects(service.reconcile(mismatch.operationId, requester.address), { code: 'EXTERNAL_TRANSACTION_MISMATCH' })
  assert.equal((await service.get(mismatch.operationId, requester.address)).status, 'reconciliation_required')
  transactions.get(mismatchHash).maxPriorityFeePerGas = fee
  check('missing fee metadata produces a typed fail-closed mismatch rather than accepting incomplete wallet evidence')
  receipts.get(mismatchHash).status = 'reverted'
  assert.equal((await service.reconcile(mismatch.operationId, requester.address)).status, 'reverted')
  const fork = await prepare(reorgRecord, 'approve_escrow')
  const forkHash = mine(fork, [event('CreditToken', 'Approval', { owner: requester.address, spender: deployment.jobEscrow, value: 6000000000000000000n }, deployment.creditToken)])
  receipts.get(forkHash).blockHash = hash('noncanonical-fork')
  const forked = await service.recordSubmittedHash(fork.operationId, forkHash, requester.address)
  assert.equal(forked.status, 'reorganized'); assert.equal(forked.canonical, false)
  await assert.rejects(prepare(reorgRecord, 'approve_escrow'), { code: 'EXTERNAL_RECONCILIATION_REQUIRED' })
  check('noncanonical receipt remains reorganized and cannot unlock another nonce or semantic action')
  // Reconcile the original transaction only; the following refund belongs to an independent funded job.
  receipts.get(forkHash).blockHash = blockHash(receipts.get(forkHash).blockNumber)
  assert.equal((await service.reconcile(fork.operationId, requester.address)).status, 'confirmed')
  const refundRecord = await fund(await agreement('refund'))
  chainTime = BigInt(refundRecord.terms.absoluteExpiry)
  const refund = await prepare(refundRecord, 'refund')
  assert.deepEqual(decoded(refund, 'JobEscrow'), { functionName: 'refund', args: [refundRecord.terms.jobId] })
  assert.equal((await confirm(refund, [event('JobEscrow', 'Refunded', { jobId: refundRecord.terms.jobId, requester: requester.address, amount: 6000000000000000000n }, deployment.jobEscrow)])).status, 'confirmed')
  check('unaccepted exact-expiry refund uses immutable requester and exact frozen labor total')
  const nonceRecord = await agreement('nonce-changed'), beforeNonce = nonce.get(lower(requester.address)) || 0
  nonceRaceWallet = lower(requester.address); nonceRaceReads = 0
  await assert.rejects(prepare(nonceRecord, 'approve_escrow'), { code: 'EXTERNAL_NONCE_CHANGED' })
  assert.ok(nonceRaceReads >= 2)
  nonceRaceWallet = null; nonce.set(lower(requester.address), beforeNonce + 1)
  assert.equal((await store.query('SELECT COUNT(*)::int AS count FROM external_wallet_intents WHERE agreement_hash=$1', [nonceRecord.hash])).rows[0].count, 0)
  check('pending nonce changing before durable preparation refuses the wallet prompt and leaves no intent row')

  const lifecycleRecord = await fund(await agreement('prompt-lifecycle'))
  extras.set(lifecycleRecord.hash, { quote: { kits: '1', maxCred: '2000000000000000000', deadline: String(chainTime + 60n) } })
  const lifecycle = await prepare(lifecycleRecord, 'buy')
  const frozenIntent = async () => (await store.query(`SELECT operation_id,chain_instance,agreement_hash,action,sender,nonce,
    destination,calldata,value,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,native_reserved,max_cred,deadline,expected,request,summary,binding
    FROM external_wallet_intents WHERE operation_id=$1`, [lifecycle.operationId])).rows[0]
  const beforePrompt = await frozenIntent()
  assert.equal(beforePrompt.max_cred, '2000000000000000000')
  assert.equal(BigInt(beforePrompt.native_reserved), BigInt(lifecycle.request.gas) * BigInt(lifecycle.request.maxFeePerGas))
  assert.equal((await service.get(lifecycle.operationId, requester.address)).status, 'prepared')
  const polled = await service.reconcile(lifecycle.operationId, requester.address)
  assert.equal(polled.status, 'prepared'); assert.deepEqual(polled.request, lifecycle.request)
  const begun = await service.beginBroadcast(lifecycle.operationId, requester.address)
  assert.equal(begun.status, 'unknown'); assert.deepEqual(begun.request, lifecycle.request)
  assert.equal((await service.get(lifecycle.operationId, requester.address)).request, null)
  assert.equal((await service.reconcile(lifecycle.operationId, requester.address)).status, 'unknown')
  await assert.rejects(service.beginBroadcast(lifecycle.operationId, requester.address), { code: 'EXTERNAL_BROADCAST_ALREADY_STARTED' })
  assert.deepEqual(await frozenIntent(), beforePrompt)
  check('prepared polling preserves the prompt; beginBroadcast durably records uncertainty and exposes the exact request only once')

  const retried = await service.retryRejectedPrompt(lifecycle.operationId, requester.address)
  assert.equal(retried.status, 'prepared'); assert.equal(retried.operationId, lifecycle.operationId)
  assert.equal(retried.nonce, lifecycle.nonce); assert.equal(retried.deadline, lifecycle.deadline)
  assert.deepEqual(retried.request, lifecycle.request); assert.deepEqual(await frozenIntent(), beforePrompt)
  await service.beginBroadcast(lifecycle.operationId, requester.address)
  latestNonceOverride = Number(lifecycle.nonce) + 1
  await assert.rejects(service.retryRejectedPrompt(lifecycle.operationId, requester.address), { code: 'EXTERNAL_NONCE_CHANGED' })
  latestNonceOverride = null; pendingNonceOverride = Number(lifecycle.nonce) + 1
  await assert.rejects(service.retryRejectedPrompt(lifecycle.operationId, requester.address), { code: 'EXTERNAL_NONCE_CHANGED' })
  pendingNonceOverride = null
  chainTime = BigInt(lifecycle.deadline)
  await assert.rejects(service.retryRejectedPrompt(lifecycle.operationId, requester.address), { code: 'EXTERNAL_INTENT_EXPIRED' })
  assert.equal((await service.get(lifecycle.operationId, requester.address)).status, 'unknown')
  assert.deepEqual(await frozenIntent(), beforePrompt)
  assert.equal((await store.query("SELECT COUNT(*)::int AS count FROM external_wallet_intents WHERE agreement_hash=$1 AND action='buy'", [lifecycleRecord.hash])).rows[0].count, 1)
  check('explicit rejected-prompt retry keeps the same intent/nonce/request/caps and refuses changed latest/pending nonce or expiry')
  console.log(JSON.stringify({ status: 'pass', checks: checks.length, scope: 'Mocked-chain external-wallet fixtures with real isolated PostgreSQL and ephemeral EIP712 signatures', publicCalls: 0, chainWrites: 0, independentHumans: 0, realSpendUsd: 0 }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks: checks.length, code: error.code, message: error.message, scope: 'Mocked-chain fixture only' }))
  process.exitCode = 1
} finally {
  await store.close()
  await administrator.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await administrator.close()
}
