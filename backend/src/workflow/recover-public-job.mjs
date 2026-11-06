import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { keccak256, stringToHex } from 'viem'
import { openTestnetRuntime } from '../chain/testnet-runtime.mjs'
import { createProcurementService } from '../procurement/service.mjs'
import { completeSyntheticJob } from './complete-job.mjs'

const root = new URL('../../../', import.meta.url)
const require = createRequire(new URL('../../package.json', import.meta.url))
const { acquireLocalLease } = require('./src/bot/checkpoint-store.cjs')

export async function recoverPublicJob() {
  const release = await acquireLocalLease('agentcity-public-contract-demo-1301')
  let runtime
  const report = { status: 'fail', mode: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', realMoneySpent: 0, economyBoundary: 'Separate synthetic contract demonstration; no token effects in Minecraft' }
  const sourcePaths = ['backend/src/workflow/recover-public-job.mjs', 'backend/src/workflow/complete-job.mjs', 'backend/src/workflow/repository.mjs', 'backend/src/chain/durable-evm.mjs', 'backend/src/chain/public-testnet.mjs', 'backend/src/delivery/evm-claims.mjs', 'backend/src/delivery/synthetic-inventory.mjs', 'backend/src/procurement/service.mjs', 'backend/src/inspection/settlement-service.mjs', 'backend/src/inspection/coordinator.mjs', 'backend/src/inspection/synthetic-world.mjs', 'backend/src/inference/proposal.mjs', 'backend/src/inference/providers.mjs', 'backend/package-lock.json', '.local/public-testnet/deployment.json']
  const snapshot = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')])))
  const recoveryId = randomUUID()
  const output = new URL(`evidence/runs/public-testnet-e2e/recovery-${recoveryId}/`, root)
  try {
    const sourceBefore = await snapshot()
    const pointer = JSON.parse(await readFile(new URL('.local/public-testnet/latest-demo.json', root), 'utf8'))
    const originalBytes = await readFile(pointer.report)
    const original = JSON.parse(originalBytes)
    report.runId = pointer.runId
    report.recoveredFrom = { path: pointer.report, sha256: createHash('sha256').update(originalBytes).digest('hex') }
    const deployment = JSON.parse(await readFile(new URL('.local/public-testnet/deployment.json', root), 'utf8'))
    runtime = await openTestnetRuntime()
    const { store, evm, accounts } = runtime
    const chainJobId = keccak256(stringToHex(pointer.runId))
    const { rows: [job] } = await store.query("SELECT * FROM ac_jobs WHERE payload->>'chainJobId'=$1", [chainJobId])
    if (!job) throw new Error('retained_public_job_required')
    const { rows: [record] } = await store.query('SELECT * FROM agreement_records WHERE agreement_hash=$1 AND state=\'funded\'', [job.agreement_digest])
    if (!record) throw new Error('funded_public_agreement_required')
    const agreement = { ...record, hash: record.agreement_hash }
    const { rows: purchases } = await store.query('SELECT * FROM procurement_operations WHERE agreement_hash=$1', [agreement.hash])
    assert.equal(purchases.length, 1, 'Recovery must select the one retained purchase, never create another')
    const purchase = purchases[0]
    const service = createProcurementService({ store, evm, deployment, account: accounts.requester, confirmations: 2 })
    if (!['confirmed', 'reverted', 'reorganized'].includes(purchase.status)) await service.broadcast(purchase.operation_id)
    await service.reconcile(purchase.operation_id)
    const purchased = await service.get(purchase.operation_id)
    assert.equal(purchased.status, 'confirmed')
    assert.ok(purchased.claim_id)
    const phases = (original.phases || []).filter(phase => ['P4', 'P5'].includes(phase.phase))
    const add = (phase, detail) => { phases.push({ phase, detail, status: 'pass' }); console.log('PASS ' + phase + ': ' + detail) }
    add('P6', 'the original signed public purchase is canonically confirmed and its claim retained')
    const before = (await store.query('SELECT operation_id FROM ac_chain_intents WHERE chain_instance=$1', [evm.instance])).rows.length
    const first = await completeSyntheticJob({ store, evm, accounts, deployment, agreement, jobId: job.id, purchased, record: add })
    const after = (await store.query('SELECT operation_id FROM ac_chain_intents WHERE chain_instance=$1', [evm.instance])).rows.length
    const repeated = await completeSyntheticJob({ store, evm, accounts, deployment, agreement, jobId: job.id, purchased })
    assert.equal(repeated.settlement.claimed, '0')
    assert.equal((await store.query('SELECT operation_id FROM ac_chain_intents WHERE chain_instance=$1', [evm.instance])).rows.length, after)
    assert.equal((await store.query('SELECT 1 FROM procurement_operations WHERE agreement_hash=$1', [agreement.hash])).rowCount, 1)
    assert.deepEqual(await snapshot(), sourceBefore, 'Recovery source changed during execution')
    Object.assign(report, first, { status: 'pass', phases, arkiv: original.arkiv, jobId: job.id, agreementHash: agreement.hash, schema: runtime.schema,
      inference: first.inference || original.inference, sources: sourceBefore,
      settledAmount: first.settlement.claimed !== '0' ? first.settlement.claimed : original.settledAmount || original.settlement?.claimed,
      transactions: original.transactions || [], purchase: { operationId: purchase.operation_id, transactionHash: purchased.transaction_hash, claimId: purchased.claim_id, spentCred: purchased.spent_cred }, newPurchases: 0, recoveryTransactions: after - before, repeatedRecoveryTransactions: 0,
      repeatedPayment: repeated.settlement.claimed, sourceIntegrityPassed: true,
      limits: ['Actual public-testnet contracts and Arkiv; agent-controlled wallets and synthetic inventory/inspection.', 'Ollama replaces0G temporarily. Independent human acceptance and authenticated Minecraft access remain final checks.'] })
  } catch (error) { report.error = { name: error.name, message: (error.shortMessage || error.message).slice(0, 1600) }; process.exitCode = 1 }
  finally {
    if (runtime) await runtime.close()
    await release()
    report.finishedAt = new Date().toISOString()
    await mkdir(output, { recursive: true })
    await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
    if (report.status === 'pass') await writeFile(new URL('.local/public-testnet/latest-demo.json', root), JSON.stringify({ schema: report.schema, runId: report.runId, report: output.pathname + 'report.json' }, null, 2) + '\n')
    console.log(JSON.stringify({ status: report.status, evidence: output.pathname + 'report.json', error: report.error }))
  }
}
