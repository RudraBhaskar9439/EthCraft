import { randomUUID } from 'node:crypto'
import { encodeFunctionData, hashTypedData } from 'viem'
import { agreementTypedData } from '../agreements/service.mjs'
import { INSPECTION_TYPES } from './coordinator.mjs'

export async function finishLocalSettlement({ jobId, store, evm, world, inspector, requester, builder, attestor, deployment, escrowAbi }) {
  await evm.verify()
  const { rows: [job] } = await store.query('SELECT * FROM ac_jobs WHERE id=$1', [jobId])
  const { rows: [record] } = await store.query('SELECT * FROM agreement_records WHERE agreement_hash=$1', [job?.agreement_digest])
  const { rows: [locked] } = await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])
  if (!job || !record || record.state !== 'funded' || !locked?.report || job.payload.chainInstance !== evm.instance) throw new Error('funded_local_job_required')
  const agreement = { hash: record.agreement_hash, domain: record.domain, terms: record.terms }
  if (hashTypedData(agreementTypedData(agreement)) !== job.agreement_digest || agreement.domain.chainId !== deployment.chainId || !(deployment.chainId === 31337 || deployment.chainId === 1301 && deployment.environment === 'PUBLIC_TESTNET_SYNTHETIC_ONLY' && evm.chain?.id === 1301) || agreement.domain.verifyingContract.toLowerCase() !== deployment.jobEscrow.toLowerCase() ||
      agreement.terms.requester !== requester.address.toLowerCase() || agreement.terms.builder !== builder.address.toLowerCase()) throw new Error('settlement_party_or_domain_mismatch')
  const status = await evm.client.readContract({ address: deployment.jobEscrow, abi: escrowAbi, functionName: 'status', args: [job.payload.chainJobId] })
  if (status[0] !== agreement.hash || status[3]) throw new Error('settlement_not_available')
  let acceptanceId = locked.pending_acceptance
  if (!status[2] && acceptanceId && await world.settlement.reverted(jobId, acceptanceId, locked.report)) {
    await world.clearRevertedAcceptance(jobId)
    acceptanceId = null
  }
  const send = async (operationId, account, name, args) => {
    await evm.prepare(operationId, account, deployment.jobEscrow, encodeFunctionData({ abi: escrowAbi, functionName: name, args }))
    await evm.broadcast(operationId)
    const result = await evm.receipt(operationId)
    if (result.status !== 'confirmed') throw new Error('settlement_confirmation_pending')
    return result
  }
  if (!status[2]) {
    const chainTime = (await evm.client.getBlock()).timestamp
    if (!locked.lock_hash || locked.lock_hash !== locked.report.lockHash || BigInt(locked.revision) !== BigInt(locked.report.revision) || chainTime >= BigInt(locked.report.validUntil)) throw new Error('protected_pass_unavailable')
    for (const [item, quantity] of Object.entries(world.manifest)) if (locked.placed_items[item] !== quantity) throw new Error('inspection_structure_changed')
    if (locked.report.jobId !== job.payload.chainJobId || locked.report.agreementHash !== agreement.hash) throw new Error('inspection_context_changed')
    const signature = await attestor.signTypedData({ domain: agreement.domain, types: INSPECTION_TYPES, primaryType: 'Inspection', message: locked.report })
    acceptanceId ||= randomUUID()
    await world.pending(jobId, acceptanceId)
    await send(acceptanceId, requester, 'accept', [job.payload.chainJobId, locked.report, signature])
  }
  if (acceptanceId) await inspector.confirmAcceptance(jobId, acceptanceId, job.payload.chainJobId, locked.report.reportHash)
  const claimId = await store.transaction(async tx => {
    const { rows: [current] } = await tx.query('SELECT payload FROM ac_jobs WHERE id=$1 FOR UPDATE', [jobId])
    const operationId = current.payload.claimOperationId || randomUUID()
    await tx.query("UPDATE ac_jobs SET payload=jsonb_set(payload,'{claimOperationId}',to_jsonb($2::text)) WHERE id=$1", [jobId, operationId])
    return operationId
  })
  const allocation = await evm.client.readContract({ address: deployment.jobEscrow, abi: escrowAbi, functionName: 'allocations', args: [job.payload.chainJobId, builder.address] })
  if (allocation > 0n) {
    const result = await send(claimId, builder, 'claim', [job.payload.chainJobId])
    return { status: 'settled', acceptanceOperationId: acceptanceId, claimOperationId: claimId, claimed: allocation.toString(), claimTransactionHash: result.hash }
  }
  const original = await evm.receipt(claimId)
  if (original.status !== 'confirmed') throw new Error('claim_outcome_requires_reconciliation')
  return { status: 'settled', acceptanceOperationId: acceptanceId, claimOperationId: claimId, claimed: '0', replay: true, claimTransactionHash: original.hash }
}
