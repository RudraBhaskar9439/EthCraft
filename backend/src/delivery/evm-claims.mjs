export class LocalClaimSource {
  constructor({ evm, store, address, abi, manifestHash, confirmations = 1 }) {
    this.evm = evm
    this.store = store
    this.address = address
    this.abi = abi
    this.manifestHash = manifestHash
    this.confirmations = confirmations
  }

  async confirmed(claimKey) {
    await this.evm.verify()
    const prefix = `${this.evm.instance}:${this.address.toLowerCase()}:`
    if (typeof claimKey !== 'string' || !claimKey.startsWith(prefix)) throw new Error('claim_domain_mismatch')
    const id = claimKey.slice(prefix.length)
    if (!/^0x[0-9a-f]{64}$/i.test(id)) throw new Error('invalid_claim_id')
    const client = this.evm.client
    let fromBlock = 0n, toBlock = 'latest'
    if (this.evm.chain?.id === 1301) {
      const { rows: [purchase] } = await this.store.query('SELECT i.receipt FROM procurement_operations p JOIN ac_chain_intents i ON i.operation_id=p.operation_id WHERE p.claim_id=$1 AND p.chain_instance=$2 AND p.status=\'confirmed\'', [id, this.evm.instance])
      if (!purchase?.receipt?.blockNumber) throw new Error('claim_purchase_receipt_required')
      fromBlock = BigInt(purchase.receipt.blockNumber)
      toBlock = fromBlock
    }
    const logs = await client.getContractEvents({ address: this.address, abi: this.abi, eventName: 'ClaimCreated', args: { claimId: id }, fromBlock, toBlock })
    if (logs.length !== 1) throw new Error('claim_event_unavailable')
    const log = logs[0]
    const head = await client.getBlockNumber({ cacheTime: 0 })
    const canonical = await client.getBlock({ blockNumber: log.blockNumber })
    if (canonical.hash !== log.blockHash || head - log.blockNumber + 1n < BigInt(this.confirmations)) throw new Error('claim_unconfirmed')
    const [chainJobId, recipient, destinationHash, kits, delivered] = await client.readContract({ address: this.address, abi: this.abi, functionName: 'claims', args: [id], blockNumber: head })
    if (kits === 0n || await client.readContract({ address: this.address, abi: this.abi, functionName: 'bundleHash' }) !== this.manifestHash) throw new Error('claim_wrong_manifest')
    const { rows: [job] } = await this.store.query("SELECT id,payload FROM ac_jobs WHERE payload->>'chainJobId'=$1", [chainJobId])
    if (!job || job.payload.chainInstance !== this.evm.instance || job.payload.kitAddress.toLowerCase() !== this.address.toLowerCase() || job.payload.requester.toLowerCase() !== recipient.toLowerCase()) throw new Error('claim_job_binding_mismatch')
    return { claimKey, confirmed: true, alreadyDelivered: delivered, jobId: job.id, manifestHash: this.manifestHash, recipient, destinationHash, kits: kits.toString(), blockHash: log.blockHash }
  }
}
