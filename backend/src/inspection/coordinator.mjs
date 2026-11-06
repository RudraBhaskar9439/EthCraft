import { keccak256, stringToHex } from 'viem'

export const INSPECTION_TYPES = { Inspection: [
  ['jobId', 'bytes32'], ['agreementHash', 'bytes32'], ['blueprintHash', 'bytes32'], ['testsHash', 'bytes32'],
  ['reportHash', 'bytes32'], ['lockHash', 'bytes32'], ['revision', 'uint64'], ['completedAt', 'uint64'], ['validUntil', 'uint64'],
  ['passed', 'bool'], ['casesPassed', 'uint16'], ['casesTotal', 'uint16']
].map(([name, type]) => ({ name, type })) }

export class InspectionCoordinator {
  constructor({ evm, world, attestor, escrow, abi, store }) {
    this.evm = evm; this.world = world; this.attestor = attestor; this.escrow = escrow; this.abi = abi; this.store = store
    if (world.mode !== 'local_synthetic_world') throw new Error('local_inspection_fixture_required')
  }

  async issue(jobId, agreement) {
    await this.evm.verify()
    const now = (await this.evm.client.getBlock()).timestamp
    const validUntil = now + 300n < BigInt(agreement.terms.passDeadline) ? now + 300n : BigInt(agreement.terms.passDeadline)
    if (now >= BigInt(agreement.terms.workDeadline) || validUntil <= now) throw new Error('inspection_deadline_expired')
    const observation = await this.world.lock(jobId, validUntil)
    const pairs = new Set(observation.rows.map(row => `${row.a}:${row.b}`))
    if (observation.rows.length !== 16 || pairs.size !== 16 || observation.rows.some(row => !Number.isInteger(row.a) || !Number.isInteger(row.b) || row.a < 0 || row.a > 3 || row.b < 0 || row.b > 3 || row.observed !== row.a + row.b)) throw new Error('inspection_did_not_pass')
    const report = { jobId: agreement.terms.jobId, agreementHash: agreement.hash, blueprintHash: agreement.terms.blueprintHash,
      testsHash: agreement.terms.testsHash, reportHash: keccak256(stringToHex(JSON.stringify({ source: observation.source, rows: observation.rows }))),
      lockHash: observation.lockHash, revision: observation.revision, completedAt: now, validUntil, passed: true, casesPassed: 16, casesTotal: 16 }
    const signature = await this.attestor.signTypedData({ domain: agreement.domain, types: INSPECTION_TYPES, primaryType: 'Inspection', message: report })
    const stored = JSON.parse(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value))
    await this.store.query('UPDATE ac_synthetic_worlds SET report=$2 WHERE job_id=$1 AND lock_hash=$3', [jobId, stored, observation.lockHash])
    return { report, signature, source: 'local_synthetic_world' }
  }

  async confirmAcceptance(jobId, operationId, chainJobId, reportHash) {
    const result = await this.evm.receipt(operationId)
    if (result.status !== 'confirmed') throw new Error('acceptance_not_final')
    const logs = await this.evm.client.getContractEvents({ address: this.escrow, abi: this.abi, eventName: 'Accepted', args: { jobId: chainJobId }, fromBlock: result.receipt.blockNumber, toBlock: result.receipt.blockNumber })
    if (!logs.some(log => log.transactionHash === result.hash && log.args.reportHash === reportHash)) throw new Error('acceptance_event_mismatch')
    await this.world.release(jobId)
  }
}

export function acceptanceVerifier({ evm, escrow, abi, store }) {
  return {
    time: async () => (await evm.client.getBlock()).timestamp,
    async reverted(jobId, operationId, report) {
      if (!operationId || !report) return false
      const { rows: [job] } = await store.query('SELECT * FROM ac_jobs WHERE id=$1', [jobId])
      if (!job || job.payload.chainInstance !== evm.instance || job.payload.chainJobId !== report.jobId || job.agreement_digest !== report.agreementHash) return false
      const known = await store.query('SELECT operation_id FROM ac_chain_intents WHERE operation_id=$1 AND chain_instance=$2', [operationId, evm.instance])
      if (!known.rowCount) return false
      const result = await evm.receipt(operationId)
      return result.status === 'reverted' && result.receipt.to.toLowerCase() === escrow.toLowerCase()
    },
    async accepted(jobId, operationId, report) {
      if (!operationId || !report) return false
      const { rows: [job] } = await store.query('SELECT * FROM ac_jobs WHERE id=$1', [jobId])
      if (!job || job.payload.chainInstance !== evm.instance || job.payload.chainJobId !== report.jobId || job.agreement_digest !== report.agreementHash) return false
      const known = await store.query('SELECT operation_id FROM ac_chain_intents WHERE operation_id=$1 AND chain_instance=$2', [operationId, evm.instance])
      if (!known.rowCount) return false
      const result = await evm.receipt(operationId)
      if (result.status !== 'confirmed' || result.receipt.to.toLowerCase() !== escrow.toLowerCase()) return false
      const logs = await evm.client.getContractEvents({ address: escrow, abi, eventName: 'Accepted', args: { jobId: report.jobId }, fromBlock: result.receipt.blockNumber, toBlock: result.receipt.blockNumber })
      return logs.some(log => log.transactionHash === result.hash && log.args.reportHash === report.reportHash)
    }
  }
}
