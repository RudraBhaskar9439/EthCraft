import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createAgreementService, prepareAgreement, AGREEMENT_TYPES } from '../../backend/src/agreements/service.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { privateKeyToAccount } = require('viem/accounts')
const { createPublicClient, http, keccak256, stringToHex } = require('viem')
const root = fileURLToPath(new URL('../../', import.meta.url))
const environment = JSON.parse(await readFile(path.join(root, '.local/backend/environment.json'), 'utf8'))
const deployment = JSON.parse(await readFile(path.join(root, 'contracts/local-deployment.json'), 'utf8'))
assert.equal(deployment.chainId, 31337)
assert.equal(new URL(deployment.rpcUrl).hostname, '127.0.0.1')
const client = createPublicClient({ transport: http(deployment.rpcUrl) })
const abi = JSON.parse(await readFile(path.join(root, 'contracts/abi/JobEscrow.json'), 'utf8'))
const requester = privateKeyToAccount('0x' + '33'.repeat(32))
const builder = privateKeyToAccount('0x' + '44'.repeat(32))
const stranger = privateKeyToAccount('0x' + '55'.repeat(32))
const runId = 'agreements-' + randomUUID()
const output = path.join(root, 'evidence/runs/local-p4', runId)
await mkdir(output, { recursive: true })
const report = { schema: 'agentcity.local-p4.agreements.v1', runId, status: 'fail', checks: [], liveFundingVerified: false, fundingVerifier: 'scripted trusted receipt fixture for backend freezing; no token transfer', startedAt: new Date().toISOString() }
const hash = text => keccak256(stringToHex(text))
const fileHash = async filename => '0x' + createHash('sha256').update(await readFile(path.join(root, filename))).digest('hex')
const schema = 'p4_agreements_' + randomUUID().replaceAll('-', '')
const admin = new PostgresStore(environment.databaseUrl)
const scopedUrl = new URL(environment.databaseUrl)
scopedUrl.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(scopedUrl.toString())
let now = Date.now()
const start = Math.floor(now / 1000)
const context = {
  domain: { chainId: 31337, verifyingContract: deployment.jobEscrow },
  serverId: deployment.serverId, bundleHash: deployment.bundleHash,
  blueprintHash: await fileHash('fixtures/blueprints/calculator-v1.json'),
  testsHash: await fileHash('fixtures/test-manifests/calculator-v1.json'),
  accessHash: await fileHash('fixtures/construction/access-v1.json'),
  cred: deployment.creditToken, kit: deployment.kitCustody
}
const scope = {
  worldId: 'synthetic-local-agreement-fixture', plotMin: [-16, 80, -8], plotMax: [15, 95, 7],
  blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5], orientation: 'identity',
  startAt: String(start), approvalExpiresAtMs: String(now + 300000),
  ownershipPolicyHash: hash('requester owns purchased materials and placed structure'),
  refundPolicyHash: hash('unaccepted absolute timeout refund; accepted entitlements remain claimable'),
  inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '0'
}
const terms = {
  jobId: hash(runId), serverId: context.serverId, version: '1', requester: requester.address,
  builder: builder.address, cred: context.cred, kit: context.kit, bundleHash: context.bundleHash,
  blueprintHash: context.blueprintHash, testsHash: context.testsHash, accessHash: context.accessHash,
  materialCap: '3000000000000000000', workDeadline: String(start + 3600),
  reviewDeadline: String(start + 4500), passDeadline: String(start + 4500), absoluteExpiry: String(start + 4500)
}
const input = { terms, scope, allocations: [{ recipient: builder.address, amount: '6000000000000000000' }] }
const service = createAgreementService({ store, context, clock: () => now,
  verifyFunding: async ({ record, evidence }) => evidence.kind === 'local-offchain-freeze-fixture' && evidence.agreementHash === record.hash })
const check = (name, details = {}) => report.checks.push({ name, status: 'pass', ...details })

try {
  await admin.query('CREATE SCHEMA ' + schema)
  await store.migrate([path.join(root, 'backend/src/agreements/schema.sql')])
  const prepared = prepareAgreement({ ...input, domain: context.domain })
  const shuffled = { ...input, terms: Object.fromEntries(Object.entries(terms).reverse()), scope: Object.fromEntries(Object.entries(scope).reverse()) }
  assert.equal(prepareAgreement({ ...shuffled, domain: context.domain }).hash, prepared.hash)
  const onchainHash = await client.readContract({ address: deployment.jobEscrow, abi, functionName: 'hashAgreement', args: [prepared.terms] })
  assert.equal(onchainHash, prepared.hash)
  check('canonical-json-key-order-and-actual-evm-eip712-digest-match', { digest: prepared.hash, contract: deployment.jobEscrow })

  await service.create(input, requester.address)
  const requesterSignature = await requester.signTypedData({ domain: prepared.domain, types: AGREEMENT_TYPES, primaryType: 'Agreement', message: prepared.terms })
  await service.approve(prepared.hash, requester.address, requesterSignature)
  await assert.rejects(service.freezeFunded(prepared.hash, { kind: 'local-offchain-freeze-fixture', agreementHash: prepared.hash }), { code: 'ALL_APPROVALS_REQUIRED' })
  await assert.rejects(service.approve(prepared.hash, stranger.address, await stranger.signTypedData({ domain: prepared.domain, types: AGREEMENT_TYPES, primaryType: 'Agreement', message: prepared.terms })), { code: 'INVALID_AGREEMENT_APPROVAL' })
  const builderSignature = await builder.signTypedData({ domain: prepared.domain, types: AGREEMENT_TYPES, primaryType: 'Agreement', message: prepared.terms })
  const approved = await service.approve(prepared.hash, builder.address, builderSignature)
  assert.equal(approved.state, 'approved')
  assert.equal((await service.approve(prepared.hash, builder.address, builderSignature)).approvals.length, 2)
  check('both-real-wallet-approvals-required-and-duplicates-do-not-count')

  const altered = prepareAgreement({ ...input, terms: { ...terms, materialCap: '4000000000000000000' }, domain: context.domain })
  assert.notEqual(altered.hash, prepared.hash)
  await assert.rejects(service.approve(prepared.hash, requester.address, await requester.signTypedData({ domain: altered.domain, types: AGREEMENT_TYPES, primaryType: 'Agreement', message: altered.terms })), { code: 'INVALID_AGREEMENT_APPROVAL' })
  check('changed-signed-material-cap-invalidates-existing-approval')

  const funded = await service.freezeFunded(prepared.hash, { kind: 'local-offchain-freeze-fixture', agreementHash: prepared.hash })
  assert.equal(funded.state, 'funded')
  assert.equal((await service.freezeFunded(prepared.hash, { kind: 'local-offchain-freeze-fixture', agreementHash: prepared.hash })).state, 'funded')
  await assert.rejects(service.replaceUnfunded(prepared.hash, { ...input, terms: { ...terms, version: '2' } }, requester.address), { code: 'FUNDED_TERMS_IMMUTABLE' })
  await assert.rejects(store.query("UPDATE agreement_records SET terms=terms || '{\"materialCap\":\"9\"}'::jsonb WHERE agreement_hash=$1", [prepared.hash]), /FUNDED_TERMS_IMMUTABLE/)
  check('funded-terms-immutable-in-service-and-postgresql')

  const successorInput = { ...input, terms: { ...terms, jobId: hash(runId + '-successor') } }
  const first = await service.create(successorInput, requester.address)
  const second = await service.replaceUnfunded(first.hash, { ...successorInput, terms: { ...successorInput.terms, version: '2', materialCap: '2' } }, requester.address)
  assert.equal((await service.get(first.hash)).state, 'superseded')
  assert.equal(second.approvals.length, 0)
  await assert.rejects(service.approve(first.hash, requester.address, requesterSignature), { code: 'AGREEMENT_NOT_APPROVABLE' })
  check('unfunded-successor-version-cannot-reuse-old-approvals')

  now = Number(scope.approvalExpiresAtMs)
  await assert.rejects(service.approve(second.hash, requester.address, requesterSignature), { code: 'AGREEMENT_APPROVAL_EXPIRED' })
  check('approval-expiry-equality-refused')
  report.status = 'pass'
} catch (error) {
  report.error = { code: error.code, message: error.message }
  process.exitCode = 1
} finally {
  await store.close()
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await admin.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: path.relative(root, output), error: report.error }))
}
