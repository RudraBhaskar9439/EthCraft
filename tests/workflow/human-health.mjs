import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { AGREEMENT_TYPES, agreementTypedData } from '../../backend/src/agreements/service.mjs'
import { createHumanDemoOperator, readSyntheticMarketHealth } from '../../backend/src/workflow/human-demo-operator.mjs'

// Only the isolated loopback database is real; chain observations and operator sends are fixture stubs.
const root = new URL('../../', import.meta.url), require = createRequire(new URL('backend/package.json', root))
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, hashTypedData, keccak256, stringToHex } = require('viem')
const [requester, builder, publisher, outsider] = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()))
const hash = value => keccak256(stringToHex(value)), address = number => getAddress('0x' + number.toString(16).padStart(40, '0'))
const registryAbi = JSON.parse(await readFile(new URL('contracts/abi/StateRegistry.json', root), 'utf8'))
const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
assert.equal(new URL(settings.databaseUrl).hostname, '127.0.0.1')
const schema = 'human_health_fixture_' + randomUUID().replaceAll('-', '')
const administrator = new PostgresStore(settings.databaseUrl), scopedUrl = new URL(settings.databaseUrl)
scopedUrl.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(scopedUrl.toString()), checks = []
const deployment = { chainId: 1301, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', genesisHash: hash('health-fixture-genesis'),
  stateRegistry: address(1), kitCustody: address(2), jobEscrow: address(3), publisher: publisher.address }
const instance = '1301:' + deployment.genesisHash, marketId = hash('health-fixture-market'), jobId = randomUUID()
let chainTime = 1000n, sequence = 7n, validUntil = 1091n, healthy = true, backed = true, observedPublisher = publisher.address
const client = {
  getChainId: async () => 1301,
  getBlock: async ({ blockNumber } = {}) => ({ timestamp: chainTime, hash: blockNumber === 0n ? deployment.genesisHash : hash('health-fixture-head') }),
  readContract: async ({ functionName }) => {
    const values = { publisher: observedPublisher, marketId, sequence, validUntil, healthy, backed, available: healthy && chainTime < validUntil }
    if (!(functionName in values)) throw new Error('UNEXPECTED_FIXTURE_READ_' + functionName)
    return values[functionName]
  }
}
const terms = Object.fromEntries(AGREEMENT_TYPES.Agreement.map(({ name, type }) => [name, type === 'address' ? address(10) : type === 'bytes32' ? hash(name) : '1']))
Object.assign(terms, { requester: requester.address, builder: builder.address, workDeadline: '4600', reviewDeadline: '5500', passDeadline: '5500', absoluteExpiry: '5500' })
const agreement = { domain: { name: 'AgentCityEscrow', version: '1', chainId: 1301, verifyingContract: deployment.jobEscrow }, terms,
  createdAtMs: Date.now(), state: 'approved', approvals: [] }
agreement.hash = hashTypedData(agreementTypedData(agreement))
for (const account of [requester, builder]) agreement.approvals.push({ signer: account.address, signature: await account.signTypedData(agreementTypedData(agreement)) })
const demo = { job_id: jobId, chain_instance: instance, identity_server_id: 'agentcity-online-auth-' + 'ab'.repeat(16),
  operation_ids: { publish: randomUUID() }, identities: Object.fromEntries([['requester', requester], ['builder', builder]].map(([role, account]) => [role,
    { playerUuid: randomUUID(), wallet: account.address, linkedAtMs: agreement.createdAtMs - 1000, source: 'historical_online_minecraft_walletlink' }])) }
const runtime = { store, client, deployment, workflow: { get: async requested => { assert.equal(requested, agreement.hash); return { demo, agreement } } } }
let nextNonce = 11, broadcastMode = 'unknown'
const prepared = new Map(), broadcasts = new Map(), outcomes = new Map()
const evm = {
  prepare: async (id, account, to, data) => {
    assert.equal(account.address.toLowerCase(), publisher.address.toLowerCase())
    assert.equal(to.toLowerCase(), deployment.stateRegistry.toLowerCase())
    const existing = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [id])).rows[0]
    if (existing) { assert.equal(existing.calldata, data); return existing }
    const decoded = decodeFunctionData({ abi: registryAbi, data })
    assert.equal(decoded.functionName, 'publish')
    const [publishedSequence, publishedHealthy, publishedUntil] = decoded.args
    assert.equal(publishedHealthy, true)
    prepared.set(id, { data, publishedSequence, publishedUntil, nonce: nextNonce })
    outcomes.set(id, 'prepared')
    return (await store.query("INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,'unsigned-health-fixture',$7) RETURNING *",
      [id, instance, account.address.toLowerCase(), to.toLowerCase(), data, nextNonce++, hash(id)])).rows[0]
  },
  broadcast: async id => {
    assert.ok(prepared.has(id))
    broadcasts.set(id, (broadcasts.get(id) || 0) + 1)
    outcomes.set(id, broadcastMode)
    if (broadcastMode === 'confirmed') {
      const input = prepared.get(id)
      sequence = input.publishedSequence; validUntil = input.publishedUntil; healthy = true
    }
  },
  receipt: async id => {
    assert.ok(prepared.has(id))
    const status = outcomes.get(id), result = { status, hash: hash(id) }
    if (status === 'confirmed') {
      const input = prepared.get(id)
      result.receipt = { logs: [{ address: deployment.stateRegistry,
        topics: encodeEventTopics({ abi: registryAbi, eventName: 'StatePublished', args: { marketId } }),
        data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bool' }, { type: 'uint64' }], [input.publishedSequence, true, input.publishedUntil]) }] }
    }
    return result
  }
}
const roleLoader = async roles => { assert.deepEqual(roles, ['publisher']); return { accounts: { publisher }, evm } }
const operator = createHumanDemoOperator(runtime, { ready: true, roleLoader })
const journalRows = async () => (await store.query("SELECT * FROM ac_outbox WHERE topic='human.market.publish' ORDER BY created_at,operation_id")).rows

try {
  await administrator.query('CREATE SCHEMA ' + schema)
  await store.migrate(['workflow/schema.sql', 'chain/schema.sql'].map(file => new URL('backend/src/' + file, root)))
  await store.query("INSERT INTO ac_jobs(id,agreement_digest,state,payload) VALUES($1,$2,'fixture',$3)", [jobId, agreement.hash, {}])

  assert.equal((await readSyntheticMarketHealth(runtime)).refreshRequired, false)
  validUntil = chainTime + 90n
  assert.equal((await readSyntheticMarketHealth(runtime)).refreshRequired, true)
  validUntil = chainTime
  const expired = await readSyntheticMarketHealth(runtime)
  assert.equal(expired.available, false)
  assert.equal(expired.refreshRequired, true)
  assert.equal(prepared.size, 0)
  assert.equal((await journalRows()).length, 0)
  checks.push('Read-only health exposes the 90-second refresh threshold and exact expiry without sending')

  await assert.rejects(createHumanDemoOperator(runtime, { roleLoader }).publishHealth(agreement.hash), /EXPLICIT_OPERATOR_READINESS_REQUIRED/)
  await assert.rejects(createHumanDemoOperator(runtime, { ready: true, roleLoader: async () => ({ accounts: { publisher: outsider }, evm }) }).publishHealth(agreement.hash), /PUBLISHER_ROLE_CHANGED/)
  observedPublisher = outsider.address
  await assert.rejects(operator.publishHealth(agreement.hash), /SYNTHETIC_HEALTH_CONTEXT_CHANGED/)
  observedPublisher = publisher.address
  assert.equal(prepared.size, 0)
  assert.equal((await journalRows()).length, 0)
  checks.push('Publication requires explicit readiness and the pinned publisher before creating an intent')

  const first = await operator.publishHealth(agreement.hash), initial = (await journalRows())[0]
  assert.equal(first.status, 'unknown')
  assert.equal(first.operationId, demo.operation_ids.publish)
  assert.equal(initial.payload.sequence, '8')
  assert.equal(initial.payload.validUntil, '1300')
  assert.equal(initial.payload.chainInstance, instance)
  assert.equal(initial.payload.registry, deployment.stateRegistry.toLowerCase())
  assert.equal(initial.payload.publisher, publisher.address.toLowerCase())
  assert.equal(initial.payload.agreementHash, agreement.hash)
  const firstRequest = prepared.get(first.operationId)
  chainTime = 1400n
  const uncertain = await operator.publishHealth(agreement.hash), retained = (await journalRows())[0]
  assert.equal(uncertain.operationId, first.operationId)
  assert.equal(uncertain.status, 'unknown')
  assert.equal((await journalRows()).length, 1)
  assert.deepEqual(retained.payload, initial.payload)
  assert.deepEqual(prepared.get(first.operationId), firstRequest)
  assert.equal(prepared.size, 1)
  assert.equal(broadcasts.get(first.operationId), 2)

  // The original publication is now observed as canonically mined before its expiry; the head has advanced beyond it.
  outcomes.set(first.operationId, 'confirmed')
  sequence = firstRequest.publishedSequence; validUntil = firstRequest.publishedUntil
  const canonical = await operator.publishHealth(agreement.hash)
  assert.equal(canonical.operationId, first.operationId)
  assert.equal(canonical.status, 'confirmed')
  assert.equal((await journalRows())[0].status, 'complete')
  assert.equal(prepared.size, 1)
  broadcastMode = 'confirmed'
  const refreshed = await operator.publishHealth(agreement.hash)
  assert.equal(refreshed.status, 'confirmed')
  assert.notEqual(refreshed.operationId, first.operationId)
  assert.equal(prepared.size, 2)
  const secondRequest = prepared.get(refreshed.operationId)
  assert.equal(secondRequest.publishedSequence, 9n)
  assert.equal(secondRequest.publishedUntil, 1700n)
  assert.equal(secondRequest.nonce, firstRequest.nonce + 1)
  assert.equal((await journalRows()).length, 2)
  assert.equal((await operator.publishHealth(agreement.hash)).status, 'already_fresh')
  assert.equal(prepared.size, 2)
  checks.push('Unknown publication retains its ID, payload and nonce; only canonical completion permits a later refresh')

  console.log(JSON.stringify({ status: 'pass', checks, scope: 'Isolated local PostgreSQL, fresh fixture approvals and mocked chain observations; zero public calls or chain writes.' }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks, message: error.message }))
  process.exitCode = 1
} finally {
  await store.close()
  await administrator.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await administrator.close()
}
