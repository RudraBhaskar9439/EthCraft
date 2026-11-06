// Real PostgreSQL receipt projection; canonical verifier responses are fixtures.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createWorkOrders } from '../../backend/src/discord/work-orders.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url)), { Pool } = require('pg')
const { keccak256, stringToHex } = require('viem')
const settings = JSON.parse(await readFile(new URL('../../.local/backend/environment.json', import.meta.url), 'utf8'))
const runId = randomUUID(), schema = 'bank_work_' + runId.replaceAll('-', ''), admin = new Pool({ connectionString: settings.databaseUrl, max: 1 })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c search_path=' + schema, max: 3 })
const report = { status: 'fail', scope: 'Actual PostgreSQL; canonical escrow reader is a labelled fixture; no chain/signing/native effects.', checks: [] }
try {
  await admin.query('CREATE SCHEMA ' + schema)
  await pool.query('CREATE TABLE ac_discord_identities(discord_user_id text PRIMARY KEY,principal_id uuid UNIQUE)')
  const requester = randomUUID(), worker = randomUUID(), discord = '111111111111111111'
  await pool.query('INSERT INTO ac_discord_identities VALUES($1,$2),($3,$4)', [discord, requester, '222222222222222222', worker])
  let verified = false
  const api = await createWorkOrders({ pool, verifyEscrowReceipt: async () => verified })
  const work = await api.createRequest({ interactionId: 'bank-test', requesterOwnerId: requester, targetOwnerId: worker, request: 'Exact platform fixture', sourcedDiscordId: discord })
  const quote = await api.proposeQuote({ workId: work.workId, actorOwnerId: worker, price: '1' })
  await api.acceptQuote({ workId: work.workId, actorOwnerId: requester, quoteId: quote.quoteId, digest: quote.digest })
  const reserve = { workId: work.workId, actorOwnerId: requester, quoteId: quote.quoteId, digest: quote.digest, operationId: randomUUID() }
  const pending = await api.reserveFunding(reserve)
  assert.equal(pending.funded, false)
  await assert.rejects(api.cancel({ workId: work.workId, actorOwnerId: requester }), /WORK_TERMS_ALREADY_CLOSED/)
  await assert.rejects(api.reserveFunding({ ...reserve, operationId: randomUUID() }), /WORK_FUNDING_INTENT_IMMUTABLE/)
  report.checks.push({ name: 'pending funding binds immutable quote and blocks cancellation', status: 'pass' })
  const chainWorkId = keccak256(stringToHex(work.workId)), resultHash = keccak256(stringToHex('native result fixture'))
  const proof = (eventName, args) => ({ confirmed: true, chainId: 31337, eventName, args: { workId: chainWorkId, ...args },
    transactionHash: keccak256(stringToHex(eventName)), blockHash: keccak256(stringToHex('block')), logIndex: 0 })
  const fund = proof('WorkFunded', { termsHash: '0x' + quote.digest, amount: quote.amountBaseUnits, requester: 'fixture-requester', worker: 'fixture-worker' })
  const project = (kind, value) => api.projectEscrow({ workId: work.workId, actorOwnerId: requester, kind, proof: value })
  await assert.rejects(project('fund', fund), /WORK_CANONICAL_ESCROW_RECEIPT_REQUIRED/)
  verified = true
  await assert.rejects(project('fund', { ...fund, args: { ...fund.args, amount: '2' } }), /WORK_EXACT_ESCROW_AMOUNT_REQUIRED/)
  const funded = await project('fund', fund); assert.equal(funded.funded, true); assert.equal(funded.executionAuthorized, false)
  await assert.rejects(pool.query("UPDATE ac_discord_work_requests SET funding='{}' WHERE id=$1", [work.workId]), /WORK_REQUEST_ACCEPTED_TERMS_IMMUTABLE/)
  await assert.rejects(pool.query("UPDATE ac_discord_work_requests SET quote='{}' WHERE id=$1", [work.workId]), /WORK_REQUEST_ACCEPTED_TERMS_IMMUTABLE/)
  await assert.rejects(project('fund', { ...fund, args: { ...fund.args, workId: '0x' + '0'.repeat(64) } }), /WORK_EXACT_ESCROW_WORK_REQUIRED/)
  report.checks.push({ name: 'only verified exact work and amount receipts establish funding', status: 'pass' })
  const start = proof('WorkStarted', { termsHash: '0x' + quote.digest }), completed = proof('WorkCompleted', { termsHash: '0x' + quote.digest, resultHash })
  await assert.rejects(project('complete', completed), /WORK_ESCROW_PROJECTION_ORDER_REQUIRED/)
  assert.equal((await project('start', start)).executionAuthorized, true)
  await project('complete', completed)
  const accepted = proof('WorkAccepted', { amount: quote.amountBaseUnits, worker: 'fixture-worker', resultHash })
  await assert.rejects(project('accept', { ...accepted, args: { ...accepted.args, resultHash: 'wrong' } }), /WORK_EXACT_ESCROW_RESULT_REQUIRED/)
  const paid = await project('accept', accepted); assert.equal(paid.paid, true)
  await assert.rejects(pool.query("UPDATE ac_discord_work_requests SET settlement='{}' WHERE id=$1", [work.workId]), /WORK_REQUEST_ACCEPTED_TERMS_IMMUTABLE/)
  assert.deepEqual(await project('accept', { ...accepted, confirmations: 7, observedAtMs: 123 }), paid)
  report.checks.push({ name: 'inspected result settles once and canonical replay preserves state', status: 'pass' })
  report.status = 'pass'
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end()
  const folder = new URL('../../evidence/runs/bank-work-orders/' + runId + '/', import.meta.url)
  await mkdir(folder, { recursive: true }); await writeFile(new URL('report.json', folder), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, evidence: folder.pathname }))
}
