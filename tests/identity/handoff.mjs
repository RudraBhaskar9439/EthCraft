import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createAgreementService } from '../../backend/src/agreements/service.mjs'
import { createIdentityService } from '../../backend/src/identity/service.mjs'
import { createHandoffService } from '../../backend/src/identity/handoff.mjs'
import { expectedWallet, signPrepared } from '../../backend/src/web/wallet.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { privateKeyToAccount } = require('viem/accounts')
const { keccak256, stringToHex } = require('viem')
const root = new URL('../../', import.meta.url)
const load = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const settings = await load('.local/backend/environment.json')
const deployment = await load('.local/public-testnet/deployment.json')
const runId = randomUUID(), schema = 'handoff_' + runId.replaceAll('-', '')
const administrator = new PostgresStore(settings.databaseUrl)
await administrator.query('CREATE SCHEMA ' + schema)
const database = new URL(settings.databaseUrl)
database.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(database.toString())
const accounts = ['33', '44', '55'].map(pair => privateKeyToAccount('0x' + pair.repeat(32)))
const [requester, builder, stranger] = accounts
const origin = 'http://127.0.0.1:8789'
let now = Date.now()
const hash = value => keccak256(stringToHex(value))
const context = { domain: { chainId: 1301, verifyingContract: deployment.jobEscrow }, serverId: deployment.serverId,
  bundleHash: deployment.bundleHash, blueprintHash: hash('handoff-fixture-blueprint'), testsHash: hash('handoff-fixture-tests'),
  accessHash: hash('handoff-fixture-access'), cred: deployment.creditToken, kit: deployment.kitCustody }
const agreements = createAgreementService({ store, context, clock: () => now })
const playerUuid = randomUUID(), sessionId = randomUUID()
let liveSession = { playerUuid, sessionId, serverId: 'handoff-fixture-server', expiresAtMs: now + 900000 }
const identity = createIdentityService({ store, clock: () => now,
  context: { serverId: liveSession.serverId, origin, chainId: 1301 },
  resolveSession: async () => liveSession })
const service = () => createHandoffService({ store, agreements, identity, deployment, origin, clock: () => now })
const checks = [], report = { status: 'fail', checks, scope: 'Actual isolated PostgreSQL with local fixture signatures and a scripted EIP-1193 provider; no public RPC call, transaction, human approval or Brave signing performed.',
  independentHumanVerified: false, realWalletApprovalPending: true, transactionsSubmitted: 0, realMoneySpent: 0 }
const check = name => { checks.push(name); console.log('PASS ' + name) }
function input() {
  const start = BigInt(Math.floor(now / 1000))
  return { terms: { jobId: hash(randomUUID()), serverId: context.serverId, version: '1', requester: requester.address,
    builder: builder.address, cred: context.cred, kit: context.kit, bundleHash: context.bundleHash,
    blueprintHash: context.blueprintHash, testsHash: context.testsHash, accessHash: context.accessHash,
    materialCap: '3000000000000000000', workDeadline: String(start + 3600n), reviewDeadline: String(start + 4500n),
    passDeadline: String(start + 4500n), absoluteExpiry: String(start + 4500n) },
  scope: { worldId: 'synthetic-handoff-fixture', plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5],
    orientation: 'identity', startAt: String(start), approvalExpiresAtMs: String(now + 300000),
    ownershipPolicyHash: hash('synthetic only'), refundPolicyHash: hash('fixed contract deadlines'), inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '0' },
  allocations: [{ recipient: builder.address, amount: '6000000000000000000' }] }
}
function provider(account, options = {}) {
  const calls = []
  let signed = false
  return { calls, async request({ method, params }) {
    calls.push(method)
    if (method === 'eth_accounts') return [signed && options.changedAccount ? stranger.address : account.address]
    if (method === 'eth_chainId') return options.wrongNetwork || (signed && options.changedNetwork) ? '0x1' : '0x515'
    if (method === 'eth_signTypedData_v4') {
      if (options.declined) throw Object.assign(new Error('fixture wallet declined'), { code: 4001 })
      assert.equal(params[0].toLowerCase(), account.address.toLowerCase())
      signed = true
      return account.signTypedData(JSON.parse(params[1]))
    }
    throw new Error('Forbidden wallet method: ' + method)
  } }
}
try {
  await store.migrate([new URL('backend/src/identity/schema.sql', root), new URL('backend/src/agreements/schema.sql', root)])
  const handoff = service()
  await handoff.initialize()
  const record = await agreements.create(input(), requester.address)
  const prepared = await handoff.prepareAgreement({ agreementHash: record.hash, account: requester.address })
  const request = await handoff.get(prepared.id, prepared.token)
  assert.equal(request.chainId, 1301)
  assert.equal(request.contracts.jobEscrow, deployment.jobEscrow.toLowerCase())
  assert.equal(request.review.materialCapBaseUnits, '3000000000000000000')
  await assert.rejects(handoff.get(prepared.id, '0'.repeat(64)), /HANDOFF_ACCESS_REQUIRED/)
  await assert.rejects(store.query("UPDATE wallet_handoffs SET payload=payload||'{\"expectedAccount\":\"other\"}'::jsonb WHERE id=$1", [prepared.id]), /HANDOFF_IMMUTABLE/)
  await store.query('UPDATE agreement_records SET allocations=$2 WHERE agreement_hash=$1', [record.hash, JSON.stringify([{ recipient: builder.address.toLowerCase(), amount: '7000000000000000000' }])])
  await assert.rejects(handoff.get(prepared.id, prepared.token), /HANDOFF_DEPLOYMENT_MISMATCH/)
  await store.query('UPDATE agreement_records SET allocations=$2 WHERE agreement_hash=$1', [record.hash, JSON.stringify(record.allocations)])
  check('immutable prepared request pins deployed contracts, chain, exact amounts and scoped access')

  for (const options of [{ wrongNetwork: true }, { changedAccount: true }, { changedNetwork: true }, { declined: true }]) {
    await assert.rejects(signPrepared(provider(requester, options), request, true))
  }
  await assert.rejects(expectedWallet(provider(stranger), request), /expected account/)
  await assert.rejects(signPrepared(provider(requester), request, false), /Review and approve/)
  await assert.rejects(signPrepared(provider(requester), { ...request, typedData: { ...request.typedData, primaryType: 'Transfer' } }, true), /supported AgentCity/)
  assert.equal((await handoff.get(prepared.id, prepared.token)).state, 'pending')
  check('provider account/network changes, declined consent and arbitrary schemas cannot submit approval')

  const wallet = provider(requester), approval = await signPrepared(wallet, request, true)
  assert.ok(wallet.calls.every(method => ['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4'].includes(method)))
  const wrong = await stranger.signTypedData(request.typedData)
  await assert.rejects(handoff.submit(prepared.id, prepared.token, { ...approval, signature: wrong }), /INVALID_HANDOFF_SIGNATURE/)
  await assert.rejects(handoff.submit(prepared.id, prepared.token, { ...approval, chainId: 1 }), /EXPLICIT_APPROVAL_AND_NETWORK_REQUIRED/)
  await assert.rejects(handoff.submit(prepared.id, prepared.token, { ...approval, typedData: request.typedData }), /HANDOFF_FIELDS/)
  const replies = await Promise.all([handoff.submit(prepared.id, prepared.token, approval), handoff.submit(prepared.id, prepared.token, approval)])
  assert.deepEqual(replies[0], replies[1])
  assert.equal((await agreements.get(record.hash)).approvals.length, 1)
  assert.equal((await service().get(prepared.id, prepared.token)).state, 'approved')
  check('server verifies exact signer and domain, delegates to agreement service and retains one approval across retries')

  const builderLink = await handoff.prepareAgreement({ agreementHash: record.hash, account: builder.address })
  const builderRequest = await handoff.get(builderLink.id, builderLink.token)
  await handoff.submit(builderLink.id, builderLink.token, await signPrepared(provider(builder), builderRequest, true))
  assert.equal((await agreements.get(record.hash)).state, 'approved')
  assert.equal((await agreements.get(record.hash)).approvals.length, 2)
  const fixtureFunding = createAgreementService({ store, context, clock: () => now, verifyFunding: async () => true })
  await fixtureFunding.freezeFunded(record.hash, { kind: 'scripted-funding-state-only-no-transaction' })
  await assert.rejects(handoff.prepareAgreement({ agreementHash: record.hash, account: requester.address }), /HANDOFF_SIGNER_NOT_REQUIRED/)
  check('two fixture-wallet approvals produce the canonical approved agreement without funding or sending a transaction')

  const identityLink = await handoff.prepareIdentity({ playerUuid, sessionId, wallet: requester.address })
  const identityRequest = await handoff.get(identityLink.id, identityLink.token)
  const identityApproval = await signPrepared(provider(requester), identityRequest, true)
  await handoff.submit(identityLink.id, identityLink.token, identityApproval)
  await handoff.submit(identityLink.id, identityLink.token, identityApproval)
  assert.equal((await identity.getLink(playerUuid)).wallet, requester.address.toLowerCase())
  liveSession = null
  await assert.rejects(handoff.prepareIdentity({ playerUuid, sessionId, wallet: requester.address }), /LIVE_GAME_SESSION_REQUIRED/)
  check('existing identity service verifies and consumes a session-bound fixture wallet challenge once')

  const longInput = input()
  longInput.scope.approvalExpiresAtMs = String(now + 30 * 60 * 1000)
  const longRecord = await agreements.create(longInput, requester.address)
  const longReview = await handoff.prepareAgreement({ agreementHash: longRecord.hash, account: requester.address })
  assert.equal(longReview.expiresAtMs, now + 15 * 60 * 1000)
  assert.equal((await agreements.get(longRecord.hash)).scope.approvalExpiresAtMs, longInput.scope.approvalExpiresAtMs)
  check('longer agreement deadlines allow fifteen minutes of review without extending the signed approval deadline')

  const later = await agreements.create(input(), requester.address)
  const expired = await handoff.prepareAgreement({ agreementHash: later.hash, account: requester.address })
  const pending = await handoff.get(expired.id, expired.token)
  const signature = await requester.signTypedData(pending.typedData)
  now = expired.expiresAtMs
  await assert.rejects(handoff.prepareAgreement({ agreementHash: later.hash, account: requester.address }), /HANDOFF_EXPIRED/)
  await assert.rejects(handoff.submit(expired.id, expired.token, { account: requester.address, chainId: 1301, consent: true, signature }), /HANDOFF_EXPIRED/)
  assert.equal((await handoff.get(expired.id, expired.token)).state, 'expired')
  const changed = createHandoffService({ store, agreements, deployment: { ...deployment, jobEscrow: stranger.address }, origin, clock: () => now })
  await assert.rejects(changed.prepareAgreement({ agreementHash: later.hash, account: requester.address }), /HANDOFF_DEPLOYMENT_MISMATCH/)
  assert.equal((await agreements.get(later.hash)).approvals.length, 0)
  check('funded or expired agreements and changed escrow context cannot create a signing handoff or approval')
  report.status = 'pass'
} catch (error) { report.error = { type: error.name, message: error.message.slice(0, 300) }; process.exitCode = 1 }
finally {
  await store.close(); await administrator.close()
  report.finishedAt = new Date().toISOString()
  report.sources = Object.fromEntries(await Promise.all(['backend/src/identity/handoff.mjs', 'backend/src/web/wallet.mjs', 'tests/identity/handoff.mjs', 'backend/src/identity/service.mjs', 'backend/src/agreements/service.mjs'].map(async file => [file, createHash('sha256').update(await readFile(new URL(file, root))).digest('hex')])))
  const output = new URL(`tests/identity/runs/handoff-${runId}/`, root)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence: new URL('report.json', output).pathname }))
}
