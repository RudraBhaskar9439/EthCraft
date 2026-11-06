import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createDiscoveryService, prepareDiscoveryRecord, discoveryTypedData } from '../../backend/src/discovery/service.mjs'
import { createArkivDiscoveryAdapter, createLocalDiscoveryFixture } from '../../backend/src/discovery/adapters.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, createWalletClient } = require('@arkiv-network/sdk')
const { localhost } = require('@arkiv-network/sdk/chains')
const { mnemonicToAccount } = require('viem/accounts')
const { http, keccak256, stringToHex } = require('viem')
const root = fileURLToPath(new URL('../../', import.meta.url))
const environment = JSON.parse(await readFile(path.join(root, '.local/backend/environment.json'), 'utf8'))
const arkiv = JSON.parse(await readFile(path.join(root, '.local/backend/arkiv-environment.json'), 'utf8'))
assert.equal(new URL(arkiv.rpcUrl).hostname, '127.0.0.1')
assert.equal(arkiv.chainId, 1337)
const publicClient = createPublicClient({ chain: localhost, transport: http(arkiv.rpcUrl) })
// These are the official local dev node's publicly known disposable accounts.
const account = index => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: index })
const builder = account(0), requester = account(1), stranger = account(2)
const adapter = signer => createArkivDiscoveryAdapter({ publicClient, walletClient: createWalletClient({ chain: localhost, transport: http(arkiv.rpcUrl), account: signer }) })
const builderAdapter = adapter(builder), requesterAdapter = adapter(requester), strangerAdapter = adapter(stranger)
const runId = 'discovery-' + randomUUID()
const output = path.join(root, 'evidence/runs/local-p4', runId)
await mkdir(output, { recursive: true })
const report = { schema: 'agentcity.local-p4.discovery.v1', runId, status: 'fail', checks: [], independentHumans: 0, localArkivNode: arkiv.rpcUrl, publicArkivVerified: false, startedAt: new Date().toISOString() }
const schema = 'p4_discovery_' + randomUUID().replaceAll('-', '')
const admin = new PostgresStore(environment.databaseUrl)
const url = new URL(environment.databaseUrl)
url.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(url.toString())
const hash = text => keccak256(stringToHex(text))
const blueprintHash = '0x' + createHash('sha256').update(await readFile(path.join(root, 'fixtures/blueprints/calculator-v1.json'))).digest('hex')
const context = { namespace: runId, serverId: hash('local-server-' + runId), chainId: 1337, blueprintHash }
const jobId = hash(runId + '-job'), agreementHash = hash(runId + '-agreement')
const zeroHash = '0x' + '00'.repeat(32)
const resolveJob = async id => {
  const row = (await store.query('SELECT * FROM discovery_test_jobs WHERE job_id=$1', [id])).rows[0]
  return row ? { requester: row.requester, agreementHash: row.agreement_hash, blueprintHash: row.blueprint_hash } : null
}
const service = (source, extra = {}) => createDiscoveryService({ store, adapter: source, context, resolveJob, ...extra })
const builderService = service(builderAdapter), requesterService = service(requesterAdapter)
const check = (name, details = {}) => report.checks.push({ name, status: 'pass', ...details })
async function envelope(signer, kind, id, payload, changes = {}) {
  const now = Date.now()
  const record = prepareDiscoveryRecord({ namespace: context.namespace, serverId: context.serverId, chainId: context.chainId, id, kind, version: 1, owner: signer.address,
    jobId: kind === 'profile' ? zeroHash : jobId, payload, issuedAtMs: now, expiresAtMs: now + 600000,
    withdrawn: false, ...changes })
  return { record, signature: await signer.signTypedData(discoveryTypedData(record)) }
}

try {
  await admin.query('CREATE SCHEMA ' + schema)
  await store.migrate([path.join(root, 'backend/src/discovery/schema.sql')])
  await store.query('CREATE TABLE discovery_test_jobs(job_id text PRIMARY KEY,requester text,agreement_hash text,blueprint_hash text)')
  await store.query('INSERT INTO discovery_test_jobs VALUES($1,$2,$3,$4)', [jobId, requester.address, agreementHash, blueprintHash])
  const profileEnvelope = await envelope(builder, 'profile', runId + '-profile', { displayName: 'Local builder fixture', service: 'calculator-v1', blueprintHash })
  const profile = await builderService.publish(profileEnvelope)
  const job = await requesterService.publish(await envelope(requester, 'job', runId + '-job', { agreementHash, blueprintHash }))
  const offerEnvelope = await envelope(builder, 'offer', runId + '-offer', { profileKey: profile.key, agreementHash, blueprintHash, laborAmount: '6000000000000000000' })
  const offer = await builderService.publish(offerEnvelope)
  const found = await requesterService.search({ kind: 'offer', jobId })
  assert.equal(found.fixture, false)
  assert.ok(found.records.some(entity => entity.key === offer.key))
  assert.equal((await requesterService.selectOffer(offer.key, jobId)).envelope.record.owner, builder.address.toLowerCase())
  report.entities = { profile: profile.key, job: job.key, offer: offer.key }
  report.transactions = [profile.transactionHash, job.transactionHash, offer.transactionHash]
  check('actual-sdk-profile-job-offer-publication-and-owner-verified-selection', { entities: report.entities, separateWalletOwners: true, independentHumans: 0 })

  assert.equal((await builderService.publish(offerEnvelope)).key, offer.key)
  check('known-identical-publication-reuses-retained-entity')

  const wrongSignature = { ...offerEnvelope, signature: await stranger.signTypedData(discoveryTypedData(offerEnvelope.record)) }
  await assert.rejects(builderService.publish(wrongSignature), { code: 'INVALID_DISCOVERY_SIGNATURE' })
  const forged = await envelope(builder, 'profile', runId + '-forged-profile', { displayName: 'Untrusted text is only display data', service: 'calculator-v1', blueprintHash })
  const external = await strangerAdapter.publish(forged)
  const profiles = await requesterService.search({ kind: 'profile' })
  assert.ok(profiles.rejected.some(entity => entity.key === external.key && entity.reason === 'UNTRUSTED_DISCOVERY_OWNER'))
  check('wrong-signature-and-actual-arkiv-owner-spoof-refused', { untrustedEntity: external.key })

  const atExpiry = service(requesterAdapter, { clock: () => offerEnvelope.record.expiresAtMs })
  await assert.rejects(atExpiry.selectOffer(offer.key, jobId), { code: 'DISCOVERY_EXPIRED_OR_FUTURE' })
  assert.ok((await store.query('SELECT * FROM discovery_records WHERE namespace=$1', [context.namespace])).rows.length >= 3)
  check('signed-expiry-equality-refused-with-retained-records-preserved')

  const withdrawn = await envelope(builder, 'offer', offerEnvelope.record.id, offerEnvelope.record.payload, { version: 2, withdrawn: true, expiresAtMs: offerEnvelope.record.expiresAtMs + 60000 })
  await builderService.publish(withdrawn)
  await assert.rejects(requesterService.selectOffer(offer.key, jobId), { code: 'STALE_OR_WITHDRAWN_OFFER' })
  assert.equal((await requesterService.search({ kind: 'offer', jobId })).records.length, 0)
  check('newer-signed-withdrawal-blocks-stale-offer-selection')

  const fixtureContext = { ...context, namespace: context.namespace + '-fixture' }
  const fixtureAdapter = createLocalDiscoveryFixture({ store, owner: builder.address })
  const fixtureService = createDiscoveryService({ store, adapter: fixtureAdapter, context: fixtureContext, resolveJob })
  const fixtureEnvelope = await envelope(builder, 'profile', runId + '-fixture-profile', profileEnvelope.record.payload, { namespace: fixtureContext.namespace })
  await fixtureService.publish(fixtureEnvelope)
  const fixtureResult = await fixtureService.search({ kind: 'profile' })
  assert.equal(fixtureResult.fixture, true)
  assert.equal(fixtureResult.records.length, 1)
  check('separate-postgresql-fixture-adapter-explicitly-labelled')
  report.status = 'pass'
} catch (error) {
  report.error = { code: error.code, message: error.shortMessage || error.message }
  process.exitCode = 1
} finally {
  await store.close()
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await admin.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: path.relative(root, output), error: report.error }))
}
