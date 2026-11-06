import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { LocalEvm } from '../backend/src/chain/local-evm.mjs'
import { SyntheticWorld } from '../backend/src/inspection/synthetic-world.mjs'
import { InspectionCoordinator, acceptanceVerifier } from '../backend/src/inspection/coordinator.mjs'
import { finishLocalSettlement } from '../backend/src/inspection/settlement-service.mjs'
import { recoverPublicJob } from '../backend/src/workflow/recover-public-job.mjs'

const args = process.argv.slice(2)
if (args.some(argument => argument !== '--public-testnet') || args.length > 1) throw new Error('unsupported_recovery_argument')
if (args.includes('--public-testnet')) {
  await recoverPublicJob()
} else {
  const require = createRequire(new URL('../backend/package.json', import.meta.url))
  const { acquireLocalLease } = require('../backend/src/bot/checkpoint-store.cjs')
  const releaseDemo = await acquireLocalLease('agentcity-local-demo-31337-8547')
  const { mnemonicToAccount } = require('viem/accounts')
  const { createPublicClient, http } = require('viem')
  const root = new URL('../', import.meta.url)
  const load = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))
  const latest = await load('.local/backend/latest-demo.json')
  if (!/^local_demo_[a-f0-9]{32}$/.test(latest.schema)) throw new Error('owned_demo_schema_required')
  const settings = await load('.local/backend/environment.json')
  const url = new URL(settings.databaseUrl); url.searchParams.set('options', '-c search_path=' + latest.schema)
  const store = new PostgresStore(url.toString())
  const report = { status: 'fail', kind: 'same-job-local-settlement-recovery', sourceRun: latest.runId, newPurchases: 0 }
  const output = new URL(`evidence/runs/local-e2e/resume-${randomUUID()}/`, root)
  try {
    const deployment = await load('contracts/local-deployment.json')
    const abi = await load('contracts/abi/JobEscrow.json')
    const job = (await store.query('SELECT * FROM ac_jobs')).rows[0]
    if (!job) throw new Error('no_pending_local_job')
    const client = createPublicClient({ transport: http(deployment.rpcUrl) })
    const evm = new LocalEvm({ store, rpcUrl: deployment.rpcUrl, genesisHash: (await client.getBlock({ blockNumber: 0n })).hash })
    const account = addressIndex => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex })
    const manifest = Object.fromEntries(Object.entries((await load('fixtures/blueprints/calculator-v1.json')).material_bill).map(([name, quantity]) => [name, String(quantity)]))
    const world = new SyntheticWorld({ store, manifest, settlement: acceptanceVerifier({ evm, escrow: deployment.jobEscrow, abi, store }) })
    const inspector = new InspectionCoordinator({ evm, world, attestor: account(3), escrow: deployment.jobEscrow, abi, store })
    report.result = await finishLocalSettlement({ jobId: job.id, store, evm, world, inspector, requester: account(4), builder: account(5), attestor: account(3), deployment, escrowAbi: abi })
    report.replay = await finishLocalSettlement({ jobId: job.id, store, evm, world, inspector, requester: account(4), builder: account(5), attestor: account(3), deployment, escrowAbi: abi })
    report.status = 'pass'; report.jobId = job.id; report.schema = latest.schema
  } catch (error) { report.error = { name: error.name, message: error.message.slice(0, 1000) }; process.exitCode = 1 }
  finally {
    await store.close(); await mkdir(output, { recursive: true }); await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); await releaseDemo()
  }
}
