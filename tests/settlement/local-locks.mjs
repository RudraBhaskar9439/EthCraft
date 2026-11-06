import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { WorkflowRepository } from '../../backend/src/workflow/repository.mjs'
import { SyntheticWorld } from '../../backend/src/inspection/synthetic-world.mjs'
const root = new URL('../../', import.meta.url)
const environment = JSON.parse(await readFile(new URL('.local/backend/environment.json', root)))
const store = new PostgresStore(environment.databaseUrl)
await store.migrate([new URL('backend/src/workflow/schema.sql', root), new URL('backend/src/inspection/schema.sql', root)])
const jobId = randomUUID()
let current = 99n, failed = false
const world = new SyntheticWorld({ store, manifest: {}, settlement: { time: async () => current, accepted: async () => false, reverted: async () => failed } })
const checks = []
try {
  await new WorkflowRepository(store).createJob({ id: jobId, agreementDigest: 'local-lock-test' })
  await world.create(jobId, randomUUID())
  await store.query('UPDATE ac_synthetic_worlds SET lock_hash=$2,valid_until=100,pending_acceptance=$3,report=$4 WHERE job_id=$1', [jobId, 'local-lock', randomUUID(), { source: 'scripted-settlement-verifier' }])
  await assert.rejects(world.release(jobId), /usable_pass_lock_required/)
  current = 101n
  await assert.rejects(world.release(jobId), /usable_pass_lock_required/)
  await assert.rejects(world.clearRevertedAcceptance(jobId), /acceptance_outcome_unknown/)
  checks.push('unknown acceptance stays locked even after pass expiry')
  failed = true; current = 99n
  await assert.rejects(world.release(jobId), /usable_pass_lock_required/)
  await world.clearRevertedAcceptance(jobId)
  assert.equal((await store.query('SELECT pending_acceptance FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0].pending_acceptance, null)
  await assert.rejects(world.release(jobId), /usable_pass_lock_required/)
  checks.push('confirmed revert clears only the acceptance attempt while a pass remains usable')
  current = 101n
  await world.pending(jobId, randomUUID())
  await world.release(jobId)
  assert.equal((await store.query('SELECT lock_hash FROM ac_synthetic_worlds WHERE job_id=$1', [jobId])).rows[0].lock_hash, null)
  checks.push('expired pass releases after independently confirmed acceptance revert')
  const output = new URL(`evidence/runs/local-settlement/${randomUUID()}/`, root)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', scope: 'Actual PostgreSQL lock transitions with a scripted canonical-outcome verifier; actual EVM acceptance/claim are covered by the local E2E flow.', checks }, null, 2) + '\n')
  console.log('PASS 3/3: pass-lock and reverted-acceptance recovery')
} finally { await store.close() }
