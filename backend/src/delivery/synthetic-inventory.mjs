import { createHash } from 'node:crypto'

const integer = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('invalid_item_quantity')
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('invalid_item_quantity')
  return BigInt(value)
}

export class SyntheticInventory {
  constructor({ store, manifest, manifestHash, claims }) {
    this.store = store
    this.manifest = manifest
    this.manifestHash = manifestHash
    this.claims = claims
    this.mode = 'local_synthetic_inventory'
  }

  async seed(items) {
    for (const [item, quantity] of Object.entries(items)) {
      if (!(item in this.manifest)) throw new Error('unknown_material')
      integer(quantity)
    }
    const { rowCount } = await this.store.query('INSERT INTO ac_synthetic_stock(manifest_hash,items) VALUES($1,$2) ON CONFLICT DO NOTHING', [this.manifestHash, items])
    if (!rowCount) throw new Error('synthetic_stock_already_initialized')
  }

  async registerDestination(destinationHash, recipient) {
    const { rows: [destination] } = await this.store.query('INSERT INTO ac_synthetic_destinations(destination_hash,recipient) VALUES($1,$2) ON CONFLICT(destination_hash) DO UPDATE SET destination_hash=excluded.destination_hash RETURNING *', [destinationHash, recipient.toLowerCase()])
    if (destination.recipient !== recipient.toLowerCase()) throw new Error('destination_owner_conflict')
  }

  async fulfill(operation) {
    const claim = await this.claims.confirmed(operation.payload.claimKey)
    if (!claim || claim.confirmed !== true || claim.claimKey !== operation.payload.claimKey || claim.manifestHash !== this.manifestHash || claim.jobId !== operation.job_id || !claim.recipient || !claim.destinationHash || !/^0x[0-9a-f]{64}$/i.test(claim.blockHash) || integer(claim.kits) === 0n) throw new Error('claim_not_authorized')
    return this.store.transaction(async tx => {
      const { rows: [lease] } = await tx.query('SELECT * FROM ac_outbox WHERE operation_id=$1 FOR UPDATE', [operation.operation_id])
      if (!lease || lease.job_id !== operation.job_id || lease.payload.claimKey !== operation.payload.claimKey) throw new Error('operation_binding_conflict')
      if (lease.status === 'applied') return lease.receipt
      const { rows: [active] } = await tx.query("SELECT operation_id FROM ac_outbox WHERE operation_id=$1 AND status='leased' AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now()", [operation.operation_id, operation.lease_owner, operation.lease_epoch])
      if (!active) throw new Error('stale_delivery_lease')
      const { rows: [stock] } = await tx.query('SELECT * FROM ac_synthetic_stock WHERE manifest_hash=$1 FOR UPDATE', [this.manifestHash])
      if (!stock) throw new Error('destination_or_stock_unavailable')
      const { rows: [old] } = await tx.query('SELECT * FROM ac_delivery_receipts WHERE claim_key=$1', [operation.payload.claimKey])
      if (old) {
        if (old.job_id !== operation.job_id || old.recipient !== claim.recipient.toLowerCase() || old.destination_hash !== claim.destinationHash) throw new Error('claim_binding_conflict')
        await tx.query("UPDATE ac_outbox SET status='applied',receipt=$2,lease_until=NULL WHERE operation_id=$1", [operation.operation_id, old])
        return old
      }
      if (claim.alreadyDelivered) throw new Error('delivered_claim_has_no_local_receipt')
      const { rows: [destination] } = await tx.query('SELECT * FROM ac_synthetic_destinations WHERE destination_hash=$1 FOR UPDATE', [claim.destinationHash])
      if (!stock || !destination || destination.recipient !== claim.recipient.toLowerCase()) throw new Error('destination_or_stock_unavailable')
      const quantities = {}
      const remaining = { ...stock.items }
      const delivered = { ...destination.items }
      for (const [item, perKit] of Object.entries(this.manifest)) {
        const count = integer(perKit) * integer(claim.kits)
        if (integer(remaining[item] || '0') < count) throw new Error('material_shortage')
        quantities[item] = count.toString()
        remaining[item] = (integer(remaining[item]) - count).toString()
        delivered[item] = (integer(delivered[item] || '0') + count).toString()
      }
      const receiptHash = '0x' + createHash('sha256').update(JSON.stringify([operation.payload.claimKey, operation.job_id, claim.recipient.toLowerCase(), claim.destinationHash, quantities])).digest('hex')
      await tx.query('UPDATE ac_synthetic_stock SET items=$2 WHERE manifest_hash=$1', [this.manifestHash, remaining])
      await tx.query('UPDATE ac_synthetic_destinations SET items=$2 WHERE destination_hash=$1', [claim.destinationHash, delivered])
      const { rows: [receipt] } = await tx.query('INSERT INTO ac_delivery_receipts(claim_key,operation_id,job_id,recipient,destination_hash,quantities,receipt_hash,source_block_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [operation.payload.claimKey, operation.operation_id, operation.job_id, claim.recipient.toLowerCase(), claim.destinationHash, quantities, receiptHash, claim.blockHash])
      await tx.query("UPDATE ac_outbox SET status='applied',receipt=$2,lease_until=NULL WHERE operation_id=$1", [operation.operation_id, receipt])
      return receipt
    })
  }
}
