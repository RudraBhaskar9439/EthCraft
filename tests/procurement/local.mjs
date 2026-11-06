import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { LocalEvm } from '../../backend/src/chain/local-evm.mjs'
import { createAgreementService, prepareAgreement, agreementTypedData } from '../../backend/src/agreements/service.mjs'
import { createProcurementService, destinationHash } from '../../backend/src/procurement/service.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, http, encodeFunctionData, parseEventLogs, keccak256, stringToHex } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const root = fileURLToPath(new URL('../../', import.meta.url))
const load = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'))
const deployment = await load('contracts/local-deployment.json')
assert.equal(deployment.environment, 'LOCAL_SYNTHETIC_ONLY')
assert.equal(deployment.chainId, 31337)
assert.equal(new URL(deployment.rpcUrl).hostname, '127.0.0.1')
const client = createPublicClient({ transport: http(deployment.rpcUrl, { retryCount: 0 }) })
assert.equal(await client.getChainId(), 31337)
const snapshot = await client.request({ method: 'evm_snapshot' })
const runId = 'procurement-' + randomUUID()
const output = path.join(root, 'evidence/runs/local-procurement', runId)
await mkdir(output, { recursive: true })
const report = { status: 'fail', runId, scope: 'Actual isolated PostgreSQL and local Anvil procurement; local chain snapshot is restored afterward', checks: [], liveExternalGatePassed: false, externalSpendingUsd: 0 }
const check = (name, details = {}) => report.checks.push({ name, status: 'pass', ...details })
const environment = await load('.local/backend/environment.json')
const administrator = new PostgresStore(environment.databaseUrl)
const schema = 'procurement_' + randomUUID().replaceAll('-', '')
const url = new URL(environment.databaseUrl)
url.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(url.toString())
// Public Anvil fixture mnemonic, never a user wallet or a public-network account.
const accounts = Array.from({ length: 6 }, (_, addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }))
const [, , publisher, , requester, builder] = accounts
const abi = Object.fromEntries(await Promise.all(['StateRegistry', 'JobEscrow', 'KitCustody'].map(async name => [name, await load(`contracts/abi/${name}.json`)])))
const hash = value => keccak256(stringToHex(value))

try {
  await administrator.query('CREATE SCHEMA ' + schema)
  await store.migrate(['chain', 'agreements', 'procurement'].map(name => path.join(root, `backend/src/${name}/schema.sql`)))
  await client.request({ method: 'evm_mine' })
  const evm = new LocalEvm({ store, rpcUrl: deployment.rpcUrl, genesisHash: (await client.getBlock({ blockNumber: 0n })).hash })
  const send = async (account, to, contractAbi, functionName, args) => {
    const operationId = randomUUID()
    await evm.prepare(operationId, account, to, encodeFunctionData({ abi: contractAbi, functionName, args }))
    await evm.broadcast(operationId)
    const outcome = await evm.receipt(operationId)
    assert.equal(outcome.status, 'confirmed')
    return { operationId, ...outcome }
  }
  const refresh = async healthy => {
    const sequence = await client.readContract({ address: deployment.stateRegistry, abi: abi.StateRegistry, functionName: 'sequence' })
    const now = (await client.getBlock()).timestamp
    await send(publisher, deployment.stateRegistry, abi.StateRegistry, 'publish', [sequence + 1n, healthy, now + 300n])
  }
  await refresh(true)
  const start = (await client.getBlock()).timestamp
  const fileHash = async name => '0x' + createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')
  const context = {
    domain: { chainId: 31337, verifyingContract: deployment.jobEscrow },
    serverId: deployment.serverId, bundleHash: deployment.bundleHash,
    blueprintHash: await fileHash('fixtures/blueprints/calculator-v1.json'),
    testsHash: await fileHash('fixtures/test-manifests/calculator-v1.json'),
    accessHash: await fileHash('fixtures/construction/access-v1.json'),
    cred: deployment.creditToken, kit: deployment.kitCustody
  }
  const input = {
    terms: {
      jobId: hash(runId), serverId: context.serverId, version: '1', requester: requester.address, builder: builder.address,
      cred: context.cred, kit: context.kit, bundleHash: context.bundleHash, blueprintHash: context.blueprintHash,
      testsHash: context.testsHash, accessHash: context.accessHash, materialCap: '3000000000000000000',
      workDeadline: String(start + 3600n), reviewDeadline: String(start + 4500n), passDeadline: String(start + 4500n), absoluteExpiry: String(start + 4500n)
    },
    scope: {
      worldId: 'local-synthetic-procurement', plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5], orientation: 'identity',
      startAt: String(start), approvalExpiresAtMs: String(Date.now() + 300000), ownershipPolicyHash: hash('requester materials'), refundPolicyHash: hash('unaccepted timeout'), inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '0'
    },
    allocations: [{ recipient: builder.address, amount: '6000000000000000000' }]
  }
  const agreement = prepareAgreement({ ...input, domain: context.domain })
  const agreements = createAgreementService({ store, context, verifyFunding: async ({ record, evidence }) => {
    const outcome = await evm.receipt(evidence.operationId)
    if (outcome.status !== 'confirmed') return false
    const events = parseEventLogs({ abi: abi.JobEscrow, logs: outcome.receipt.logs.filter(log => log.address.toLowerCase() === deployment.jobEscrow.toLowerCase()), eventName: 'Funded' })
    return events.length === 1 && events[0].args.agreementHash === record.hash
  } })
  await agreements.create(input, requester.address)
  const requesterSignature = await requester.signTypedData(agreementTypedData(agreement))
  const builderSignature = await builder.signTypedData(agreementTypedData(agreement))
  await agreements.approve(agreement.hash, requester.address, requesterSignature)
  await agreements.approve(agreement.hash, builder.address, builderSignature)
  const funding = await send(requester, deployment.jobEscrow, abi.JobEscrow, 'fund', [agreement.terms, agreement.allocations.map(row => row.recipient), agreement.allocations.map(row => BigInt(row.amount)), requesterSignature, builderSignature])
  await agreements.freezeFunded(agreement.hash, { operationId: funding.operationId })
  check('genuine-local-wallet-approvals-and-actual-escrow-funding-before-procurement')

  let loseSendResponse = true
  const transportFault = {
    instance: evm.instance, client: evm.client, verify: () => evm.verify(), prepare: (...args) => evm.prepare(...args), receipt: (...args) => evm.receipt(...args),
    broadcast: async operationId => {
      const sent = await evm.broadcast(operationId)
      if (loseSendResponse) { loseSendResponse = false; return { status: 'unknown', hash: sent.hash } }
      return sent
    }
  }
  const service = createProcurementService({ store, evm: transportFault, deployment, account: requester })
  const quoteDeadline = (await client.getBlock()).timestamp + 60n
  const quote = () => ({ operationId: randomUUID(), agreementHash: agreement.hash, kits: '1', maxCred: '2000000000000000000', deadline: String(quoteDeadline) })
  const first = quote()
  const second = quote()
  const raced = await Promise.allSettled([service.prepare(first), service.prepare(second)])
  report.reservationRace = raced.map(result => result.status === 'fulfilled'
    ? { status: result.status, operationId: result.value.operation_id }
    : { status: result.status, code: result.reason.code, message: result.reason.message })
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'MATERIAL_CAP_EXCEEDED')
  const chosen = raced[0].status === 'fulfilled' ? first : second
  const prepared = raced.find(result => result.status === 'fulfilled').value
  assert.equal((await service.budget(agreement.hash)).reserved, first.maxCred)
  assert.equal(prepared.destination_hash, destinationHash(agreement))
  check('concurrent-reservations-cannot-exceed-aggregate-signed-material-cap', { reserved: first.maxCred })

  assert.equal((await service.prepare(chosen)).transaction_hash, prepared.transaction_hash)
  await assert.rejects(service.prepare({ ...chosen, maxCred: '1900000000000000000' }), { code: 'PROCUREMENT_OPERATION_CONFLICT' })
  await assert.rejects(service.prepare({ ...quote(), recipient: builder.address }), { code: 'PROCUREMENT_FIELDS' })
  const foreign = createProcurementService({ store, evm, deployment, account: builder })
  await assert.rejects(foreign.prepare(quote()), { code: 'PROCUREMENT_AGREEMENT_CONTEXT' })
  check('operation-call-binding-fixed-destination-and-requester-authority-refused-before-send')

  const unknown = await service.broadcast(chosen.operationId)
  assert.equal(unknown.status, 'unknown')
  assert.equal((await service.budget(agreement.hash)).reserved, chosen.maxCred)
  const confirmed = await service.reconcile(chosen.operationId)
  assert.equal(confirmed.status, 'confirmed')
  assert.ok(confirmed.claim_id)
  assert.ok(BigInt(confirmed.spent_cred) > 0n && BigInt(confirmed.spent_cred) < BigInt(chosen.maxCred))
  const budget = await service.budget(agreement.hash)
  assert.equal(budget.reserved, '0')
  assert.equal(budget.spent, confirmed.spent_cred)
  assert.equal(BigInt(budget.available), BigInt(budget.cap) - BigInt(confirmed.spent_cred))
  const replay = await service.broadcast(chosen.operationId)
  assert.equal(replay.transaction_hash, confirmed.transaction_hash)
  assert.equal((await service.reconcile(chosen.operationId)).claim_id, confirmed.claim_id)
  check('lost-send-response-keeps-cap-until-canonical-purchased-and-claim-events-settle-actual-spend', { transactionHash: confirmed.transaction_hash, claimId: confirmed.claim_id, actualSpent: confirmed.spent_cred })

  const revertQuote = { ...quote(), maxCred: '1900000000000000000' }
  await service.prepare(revertQuote)
  await refresh(false)
  await service.broadcast(revertQuote.operationId)
  const reverted = await service.reconcile(revertQuote.operationId)
  assert.equal(reverted.status, 'reverted')
  assert.equal((await service.budget(agreement.hash)).reserved, '0')
  assert.equal((await service.budget(agreement.hash)).spent, confirmed.spent_cred)
  check('canonical-reverted-purchase-releases-only-its-reservation-without-extra-spend')
  report.status = 'pass'
} catch (error) {
  report.error = { code: error.code, message: error.message }
  process.exitCode = 1
} finally {
  await store.close()
  await administrator.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await administrator.close()
  report.snapshotRestored = await client.request({ method: 'evm_revert', params: [snapshot] })
  if (!report.snapshotRestored) { report.status = 'fail'; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, snapshotRestored: report.snapshotRestored, evidence: path.relative(root, output), error: report.error }))
}
