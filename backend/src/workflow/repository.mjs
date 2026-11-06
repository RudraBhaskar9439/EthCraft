import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export class WorkflowRepository {
  constructor(store) { this.store = store }

  async createJob({ id, agreementDigest, state = 'local_ready', payload = {}, maxAttempts = 20, maxActions = 3 }) {
    return this.store.transaction(async tx => {
      await tx.query('INSERT INTO ac_jobs(id,agreement_digest,state,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, agreementDigest, state, payload])
      const { rows: [job] } = await tx.query('SELECT * FROM ac_jobs WHERE id=$1 FOR UPDATE', [id])
      if (job.agreement_digest !== agreementDigest) throw new Error('job_binding_conflict')
      await tx.query('INSERT INTO ac_inference_budgets(job_id,max_attempts,max_actions) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, maxAttempts, maxActions])
      return job
    })
  }

  async reserveAttempt(jobId) {
    return this.store.transaction(async tx => {
      const result = await tx.query('UPDATE ac_inference_budgets SET attempts=attempts+1 WHERE job_id=$1 AND attempts<max_attempts RETURNING attempts', [jobId])
      if (!result.rowCount) throw new Error('inference_budget_exhausted')
      const id = randomUUID()
      await tx.query('INSERT INTO ac_inference_attempts(id,job_id) VALUES($1,$2)', [id, jobId])
      return id
    })
  }

  async recordDecision(jobId, attemptId, result, binding) {
    const id = randomUUID()
    return this.store.transaction(async tx => {
      const changed = await tx.query("UPDATE ac_inference_attempts SET status='recorded',result=$3 WHERE id=$1 AND job_id=$2 AND status='reserved'", [attemptId, jobId, result])
      if (!changed.rowCount) throw new Error('attempt_already_recorded')
      await tx.query('INSERT INTO ac_decisions(id,job_id,attempt_id,proposal,binding) VALUES($1,$2,$3,$4,$5)', [id, jobId, attemptId, result.proposal, binding])
      return { id, ...result }
    })
  }

  async getDecision(id) { return (await this.store.query('SELECT * FROM ac_decisions WHERE id=$1', [id])).rows[0] }

  async enqueueDecision(id, binding, topic, payload) {
    return this.store.transaction(async tx => {
      const { rows: [decision] } = await tx.query('SELECT * FROM ac_decisions WHERE id=$1 FOR UPDATE', [id])
      if (!decision || decision.status !== 'proposed') throw new Error('decision_unavailable')
      if (!isDeepStrictEqual(decision.binding, binding)) throw new Error('decision_binding_changed')
      if (decision.proposal.action === 'wait') throw new Error('waiting_proposal')
      const budget = await tx.query('UPDATE ac_inference_budgets SET actions=actions+1 WHERE job_id=$1 AND actions<max_actions RETURNING actions', [decision.job_id])
      if (!budget.rowCount) throw new Error('action_budget_exhausted')
      const operationId = randomUUID()
      await tx.query('INSERT INTO ac_outbox(operation_id,job_id,topic,payload) VALUES($1,$2,$3,$4)', [operationId, decision.job_id, topic, payload])
      await tx.query("UPDATE ac_decisions SET status='queued' WHERE id=$1", [id])
      return operationId
    })
  }

  async enqueue(jobId, operationId, topic, payload) {
    return this.store.transaction(async tx => {
      const { rows: [existing] } = await tx.query('SELECT * FROM ac_outbox WHERE operation_id=$1 FOR UPDATE', [operationId])
      if (existing) {
        if (existing.job_id !== jobId || existing.topic !== topic || !isDeepStrictEqual(existing.payload, payload)) throw new Error('operation_binding_conflict')
        return existing
      }
      return (await tx.query('INSERT INTO ac_outbox(operation_id,job_id,topic,payload) VALUES($1,$2,$3,$4) RETURNING *', [operationId, jobId, topic, payload])).rows[0]
    })
  }

  async claim(owner, seconds = 30, topic, jobId) {
    if (typeof owner !== 'string' || !owner || !Number.isInteger(seconds) || seconds < 1 || seconds > 60 || typeof topic !== 'string' || !topic) throw new Error('invalid_lease')
    return this.store.transaction(async tx => {
      const { rows: [operation] } = await tx.query("SELECT operation_id FROM ac_outbox WHERE topic=$1 AND ($2::uuid IS NULL OR job_id=$2) AND status IN ('pending','leased') AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [topic, jobId ?? null])
      if (!operation) return null
      return (await tx.query("UPDATE ac_outbox SET status='leased',lease_owner=$2,lease_epoch=lease_epoch+1,lease_until=now()+$3*interval '1 second' WHERE operation_id=$1 RETURNING *", [operation.operation_id, owner, seconds])).rows[0]
    })
  }
}
