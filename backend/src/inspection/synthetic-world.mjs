import { randomBytes } from 'node:crypto'

export class SyntheticWorld {
  constructor({ store, manifest, settlement }) { this.store = store; this.manifest = manifest; this.settlement = settlement; this.mode = 'local_synthetic_world' }

  async create(jobId, destinationHash) {
    await this.store.query('INSERT INTO ac_synthetic_worlds(job_id,destination_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [jobId, destinationHash])
  }

  async construct(jobId, operation) {
    const operationId = operation.operation_id
    return this.store.transaction(async tx => {
      const { rows: [lease] } = await tx.query("SELECT * FROM ac_outbox WHERE operation_id=$1 AND job_id=$2 AND topic='construct' FOR UPDATE", [operationId, jobId])
      if (!lease || lease.lease_owner !== operation.lease_owner || lease.lease_epoch !== operation.lease_epoch) throw new Error('stale_build_lease')
      const { rows: [job] } = await tx.query('SELECT payload FROM ac_jobs WHERE id=$1', [jobId])
      if (!job || lease.payload.actorId !== job.payload.builderActorId) throw new Error('build_actor_not_authorized')
      const { rows: [world] } = await tx.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1 FOR UPDATE', [jobId])
      if (!world || world.lock_hash) throw new Error('world_unavailable_or_locked')
      if (world.build_operation) {
        if (world.build_operation !== operationId) throw new Error('build_already_recorded')
        return world
      }
      const { rowCount } = await tx.query("SELECT operation_id FROM ac_outbox WHERE operation_id=$1 AND status='leased' AND lease_until>now() AND (payload->>'expiresAtMs')::bigint>extract(epoch FROM now())*1000", [operationId])
      if (!rowCount || lease.payload.expectedRevision !== Number(world.revision)) throw new Error('build_context_changed')
      const { rows: [inventory] } = await tx.query('SELECT * FROM ac_synthetic_destinations WHERE destination_hash=$1 FOR UPDATE', [world.destination_hash])
      if (!inventory) throw new Error('inventory_unavailable')
      const remaining = { ...inventory.items }
      for (const [item, quantity] of Object.entries(this.manifest)) {
        if (BigInt(remaining[item] || '0') < BigInt(quantity)) throw new Error('material_shortage')
        remaining[item] = (BigInt(remaining[item]) - BigInt(quantity)).toString()
      }
      await tx.query('UPDATE ac_synthetic_destinations SET items=$2 WHERE destination_hash=$1', [world.destination_hash, remaining])
      const built = (await tx.query('UPDATE ac_synthetic_worlds SET revision=144,placed_items=$2,build_operation=$3 WHERE job_id=$1 RETURNING *', [jobId, this.manifest, operationId])).rows[0]
      await tx.query("UPDATE ac_outbox SET status='applied',receipt=$2,lease_until=NULL WHERE operation_id=$1", [operationId, { revision: 144, mode: this.mode }])
      return built
    })
  }

  async lock(jobId, validUntil) {
    return this.store.transaction(async tx => {
      const { rows: [world] } = await tx.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1 FOR UPDATE', [jobId])
      if (!world || world.revision !== '144' || !world.build_operation || world.lock_hash) throw new Error('world_not_ready_for_inspection')
      const lockHash = '0x' + randomBytes(32).toString('hex')
      await tx.query('UPDATE ac_synthetic_worlds SET lock_hash=$2,valid_until=$3 WHERE job_id=$1', [jobId, lockHash, validUntil.toString()])
      // Explicit arithmetic fixture. This is never represented as a Minecraft lamp observation.
      const rows = Array.from({ length: 16 }, (_, index) => ({ a: Math.floor(index / 4), b: index % 4, observed: Math.floor(index / 4) + index % 4 }))
      return { lockHash, revision: 144n, rows, source: 'local_synthetic_world' }
    })
  }

  async pending(jobId, operationId) {
    const result = await this.store.query('UPDATE ac_synthetic_worlds SET pending_acceptance=$2 WHERE job_id=$1 AND lock_hash IS NOT NULL AND (pending_acceptance IS NULL OR pending_acceptance=$2) RETURNING job_id', [jobId, operationId])
    if (!result.rowCount) throw new Error('inspection_lock_unavailable')
  }

  async release(jobId) {
    return this.store.transaction(async tx => {
      const { rows: [world] } = await tx.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1 FOR UPDATE', [jobId])
      if (!world || !world.lock_hash) return
      const chainTime = await this.settlement.time()
      const terminalVerified = await this.settlement.accepted(jobId, world.pending_acceptance, world.report)
      const reverted = world.pending_acceptance && await this.settlement.reverted?.(jobId, world.pending_acceptance, world.report)
      if (!terminalVerified && ((world.pending_acceptance && !reverted) || BigInt(world.valid_until) > chainTime)) throw new Error('usable_pass_lock_required')
      await tx.query('UPDATE ac_synthetic_worlds SET lock_hash=NULL,pending_acceptance=NULL WHERE job_id=$1', [jobId])
    })
  }

  async clearRevertedAcceptance(jobId) {
    return this.store.transaction(async tx => {
      const { rows: [world] } = await tx.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1 FOR UPDATE', [jobId])
      if (!world?.pending_acceptance || !await this.settlement.reverted?.(jobId, world.pending_acceptance, world.report)) throw new Error('acceptance_outcome_unknown')
      await tx.query('UPDATE ac_synthetic_worlds SET pending_acceptance=NULL WHERE job_id=$1', [jobId])
    })
  }
}
