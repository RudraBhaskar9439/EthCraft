import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { WorkflowRepository } from '../../backend/src/workflow/repository.mjs'

const root = new URL('../../', import.meta.url)
const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
const admin = new PostgresStore(settings.databaseUrl)
const schema = 'job_claim_' + randomUUID().replaceAll('-', '')
await admin.query('CREATE SCHEMA ' + schema)
const url = new URL(settings.databaseUrl)
url.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(url.toString())
try {
  await store.migrate([new URL('backend/src/workflow/schema.sql', root)])
  const repository = new WorkflowRepository(store)
  const jobs = [randomUUID(), randomUUID()]
  for (const id of jobs) {
    await repository.createJob({ id, agreementDigest: 'isolated-scope-test' })
    await repository.enqueue(id, randomUUID(), 'construct', { jobId: id })
  }
  assert.equal((await repository.claim('scoped-worker', 30, 'construct', jobs[1])).job_id, jobs[1])
  assert.equal((await repository.claim('legacy-worker', 30, 'construct')).job_id, jobs[0])
  const output = new URL(`evidence/runs/workflow-job-claims/${randomUUID()}/`, root)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', checks: ['a job-scoped worker cannot claim the older other job', 'existing unscoped workers retain their queue behavior'], externalTransactions: 0 }, null, 2) + '\n')
  console.log('PASS 2/2: durable worker claims respect the selected job')
} finally { await store.close(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.close() }
