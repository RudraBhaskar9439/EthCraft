import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseAbi } from '../../backend/node_modules/viem/_esm/index.js'
import { createPoolObservationPublisher } from '../../backend/src/bank/pool-observations.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID()
const output = join(root, 'evidence/runs/marketplace-observations', runId)
await mkdir(output, { recursive: true })
const report = { runId, status: 'fail', publicTransactions: 0, walletSignatures: 0,
  scope: 'In-memory lost-reply and canonical-result fixtures; no real RPC or signer.', checks: [] }
const values = new Map(), prepared = new Map(), abi = parseAbi(['function checkpoint()'])
const manifest = { deploymentId: 'fixture', hook: '0x' + '1'.repeat(40), roles: { publisher: '0x' + '2'.repeat(40) },
  maxGas: 500000, maxNativeCostWei: '1000000000000' }
const store = { get: async (_, key) => values.get(key), put: async (_, key, value) => values.set(key, structuredClone(value)),
  lock: async (_, key, work) => work() }
let loseReply = true, reverted = false, pending = false, signatures = 0, proofReady = true
const publisher = {
  async prepare(input) {
    assert.equal(input.to, manifest.hook)
    assert.equal(values.get('marketplace:pool-observation').operationId, input.operationId, 'Persist before signing')
    if (prepared.has(input.operationId)) assert.deepEqual(prepared.get(input.operationId), input)
    else { prepared.set(input.operationId, input); signatures++ }
  },
  async broadcast() { if (loseReply) { loseReply = false; throw Error('lost checkpoint reply') } },
  async reconcile() { return pending ? {} : { status: reverted ? 'reverted' : 'confirmed', transactionHash: '0x' + '3'.repeat(64) } }
}
const reader = { transaction: async request => {
  assert.equal(request.from, manifest.roles.publisher); assert.equal(request.to, manifest.hook)
  return { confirmed: proofReady, transactionHash: request.transactionHash }
} }
const create = () => createPoolObservationPublisher({ store, manifest, reader, publisher, abi })
try {
  await assert.rejects(create()(), /lost checkpoint reply/)
  const original = values.get('marketplace:pool-observation').operationId
  assert.equal((await create()()).pending, false)
  assert.equal(signatures, 1)
  assert.equal(values.get('marketplace:pool-observation').operationId, original)
  report.checks.push('Lost submitted reply and service recreation reuse one persisted checkpoint and signature')
  pending = true
  assert.equal((await create()()).pending, true)
  const pendingId = values.get('marketplace:pool-observation').operationId
  pending = false; proofReady = false
  assert.equal((await create()()).pending, true)
  assert.equal(values.get('marketplace:pool-observation').operationId, pendingId)
  proofReady = true
  await create()()
  report.checks.push('Missing receipt or canonical confirmation preserves the original pending operation')
  reverted = true
  await assert.rejects(create()(), /MARKETPLACE_CHECKPOINT_REVERT_RECORDED/)
  const failed = values.get('marketplace:pool-observation')
  assert.equal(failed.status, 'reverted')
  assert.equal(values.get('marketplace:pool-observation:' + failed.operationId).status, 'reverted')
  reverted = false
  await create()()
  assert.notEqual(values.get('marketplace:pool-observation').operationId, failed.operationId)
  report.checks.push('Canonical revert is retained; an explicit later checkpoint receives a fresh operation ID')
  report.status = 'pass'
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  report.sourceHashes = Object.fromEntries(await Promise.all(['backend/src/bank/pool-observations.mjs', 'tests/bank/pool-observations.mjs']
    .map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(output, 'report.json') }))
}
