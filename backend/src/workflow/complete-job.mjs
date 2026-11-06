import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { encodeFunctionData } from 'viem'
import { WorkflowRepository } from './repository.mjs'
import { LocalClaimSource } from '../delivery/evm-claims.mjs'
import { SyntheticInventory } from '../delivery/synthetic-inventory.mjs'
import { SyntheticWorld } from '../inspection/synthetic-world.mjs'
import { InspectionCoordinator, acceptanceVerifier } from '../inspection/coordinator.mjs'
import { finishLocalSettlement } from '../inspection/settlement-service.mjs'
import { DecisionService } from '../inference/decision-service.mjs'
import { localOllama } from '../inference/providers.mjs'
import { destinationHash } from '../procurement/service.mjs'

const root = new URL('../../../', import.meta.url)
export async function completeSyntheticJob({ store, evm, accounts, deployment, agreement, jobId, purchased, record = () => {} }) {
  const { requester, builder, attestor, warehouse } = accounts
  const repository = new WorkflowRepository(store)
  const loadAbi = async name => JSON.parse(await readFile(new URL(`contracts/abi/${name}.json`, root), 'utf8'))
  const [kitAbi, escrowAbi] = await Promise.all([loadAbi('KitCustody'), loadAbi('JobEscrow')])
  const manifest = Object.fromEntries(Object.entries(JSON.parse(await readFile(new URL('fixtures/blueprints/calculator-v1.json', root), 'utf8')).material_bill).map(([item, count]) => [item, String(count)]))
  const destination = destinationHash(agreement)
  const { rows: [job] } = await store.query('SELECT * FROM ac_jobs WHERE id=$1', [jobId])
  if (!job || job.payload.chainInstance !== evm.instance || job.agreement_digest !== agreement.hash) throw new Error('synthetic_job_binding_changed')
  async function operationId(key) {
    return store.transaction(async tx => {
      const { rows: [current] } = await tx.query('SELECT payload FROM ac_jobs WHERE id=$1 FOR UPDATE', [jobId])
      const id = current.payload[key] || randomUUID()
      await tx.query('UPDATE ac_jobs SET payload=jsonb_set(payload,$2::text[],to_jsonb($3::text)) WHERE id=$1', [jobId, [key], id])
      return id
    })
  }
  const claims = new LocalClaimSource({ evm, store, address: deployment.kitCustody, abi: kitAbi, manifestHash: deployment.bundleHash, confirmations: deployment.chainId === 1301 ? 2 : 1 })
  const inventory = new SyntheticInventory({ store, manifest, manifestHash: deployment.bundleHash, claims })
  if (!(await store.query('SELECT 1 FROM ac_synthetic_stock WHERE manifest_hash=$1', [deployment.bundleHash])).rowCount) {
    const stock = Object.fromEntries(await Promise.all(Object.keys(manifest).map(async (item, index) => [item, String(await evm.client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'controlledStock', args: [BigInt(index)] }))])))
    await inventory.seed(stock)
  }
  await inventory.registerDestination(destination, requester.address)
  const claimKey = `${evm.instance}:${deployment.kitCustody.toLowerCase()}:${purchased.claim_id}`
  let receipt = (await store.query('SELECT * FROM ac_delivery_receipts WHERE claim_key=$1', [claimKey])).rows[0]
  if (!receipt) {
    const id = await operationId('deliveryOperationId')
    await repository.enqueue(jobId, id, 'deliver', { claimKey })
    const operation = await repository.claim('synthetic-delivery-worker', 30, 'deliver', jobId)
    if (!operation) throw new Error('delivery_worker_lease_pending')
    receipt = await inventory.fulfill(operation)
    assert.equal((await inventory.fulfill(operation)).receipt_hash, receipt.receipt_hash)
  }
  const verified = await claims.confirmed(claimKey)
  if (verified.jobId !== jobId || verified.recipient.toLowerCase() !== requester.address.toLowerCase() || verified.destinationHash !== destination) throw new Error('delivery_receipt_context_changed')
  if (!verified.alreadyDelivered) {
    const id = await operationId('deliveryAcknowledgementId')
    await evm.prepare(id, warehouse, deployment.kitCustody, encodeFunctionData({ abi: kitAbi, functionName: 'markDelivered', args: [purchased.claim_id, receipt.receipt_hash] }))
    await evm.broadcast(id)
    assert.equal((await evm.receipt(id)).status, 'confirmed')
  }
  record('P7', 'one canonical purchase claim supplies the synthetic destination exactly once')
  const world = new SyntheticWorld({ store, manifest, settlement: acceptanceVerifier({ evm, escrow: deployment.jobEscrow, abi: escrowAbi, store }) })
  await world.create(jobId, destination)
  let current = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0]
  let inference = null
  if (!current.build_operation) {
    const leaseUntilMs = Date.now() + 60000
    const decisions = new DecisionService({ repository, provider: localOllama, observe: async () => {
      const state = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0]
      return { jobId, actorId: job.payload.builderActorId, sessionGeneration: 1, leaseEpoch: 1, leaseUntilMs,
        agreementDigest: agreement.hash, expectedRevision: Number(state.revision), actorAuthorized: true,
        authorizedConstruction: !state.build_operation && !state.lock_hash, lockMode: state.lock_hash ? 'REVIEW' : 'NONE' }
    } })
    const queued = (await store.query("SELECT * FROM ac_outbox WHERE job_id=$1 AND topic='construct' AND status IN ('pending','leased') ORDER BY created_at DESC LIMIT 1", [jobId])).rows[0]
    if (queued && queued.payload.expiresAtMs <= Date.now()) {
      await store.query("UPDATE ac_outbox SET status='expired' WHERE operation_id=$1 AND status IN ('pending','leased')", [queued.operation_id])
    }
    if (!queued || queued.payload.expiresAtMs <= Date.now()) {
      const proposed = await decisions.propose(jobId)
      inference = proposed.evidence
      assert.equal(proposed.proposal.action, 'construct', 'Local model must authorize the synthetic construction')
      assert.equal((await decisions.execute(proposed.id)).status, 'queued')
    }
    const construction = await repository.claim('synthetic-builder-worker', 30, 'construct', jobId)
    if (!construction) throw new Error('construction_worker_lease_pending')
    await world.construct(jobId, construction)
  }
  record('P3', 'actual local Ollama decision executes only through fresh authority and a fenced receiver')
  current = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0]
  const inspector = new InspectionCoordinator({ evm, world, attestor, escrow: deployment.jobEscrow, abi: escrowAbi, store })
  let inspection = current.report
  if (!inspection) inspection = await inspector.issue(jobId, agreement)
  const chainStatus = await evm.client.readContract({ address: deployment.jobEscrow, abi: escrowAbi, functionName: 'status', args: [job.payload.chainJobId] })
  if (!chainStatus[2] && (current.lock_hash || !current.report)) await assert.rejects(world.release(jobId), /usable_pass_lock_required/)
  const settlement = await finishLocalSettlement({ jobId, store, evm, world, inspector, requester, builder, attestor, deployment, escrowAbi })
  assert.equal(settlement.claimed, settlement.replay ? '0' : '6000000000000000000')
  const repeated = await finishLocalSettlement({ jobId, store, evm, world, inspector, requester, builder, attestor, deployment, escrowAbi })
  assert.equal(repeated.replay, true)
  assert.equal(repeated.claimed, '0')
  assert.equal((await store.query('SELECT lock_hash FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0].lock_hash, null)
  record('P8', 'protected synthetic inspection, requester acceptance and one fixed payment; replay pays zero')
  return { inference, inspectionSource: inspection.source || 'local_synthetic_world', settlement, deliveryReceipt: receipt.receipt_hash }
}
