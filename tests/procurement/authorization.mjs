import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { LocalEvm } from '../../backend/src/chain/local-evm.mjs'
import { createProcurementService } from '../../backend/src/procurement/service.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, http, keccak256, stringToHex } = require('viem')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deployment = JSON.parse(await readFile(path.join(root, 'contracts/local-deployment.json'), 'utf8'))
const environment = JSON.parse(await readFile(path.join(root, '.local/backend/environment.json'), 'utf8'))
const administrator = new PostgresStore(environment.databaseUrl)
const schema = 'procurement_authorization_' + randomUUID().replaceAll('-', '')
const url = new URL(environment.databaseUrl)
url.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(url.toString())
const client = createPublicClient({ transport: http(deployment.rpcUrl, { retryCount: 0 }) })
const genesisHash = (await client.getBlock({ blockNumber: 0n })).hash
const evm = new LocalEvm({ store, rpcUrl: deployment.rpcUrl, genesisHash })
const runId = 'authorization-' + randomUUID()
const output = path.join(root, 'evidence/runs/local-procurement', runId)
await mkdir(output, { recursive: true })
const report = { status: 'fail', scope: 'Actual PostgreSQL row-authorization regression with a synthetic reserved row; chain is read-only, no snapshot or transaction', checks: [] }

try {
  await administrator.query('CREATE SCHEMA ' + schema)
  await store.migrate(['agreements', 'procurement'].map(name => path.join(root, `backend/src/${name}/schema.sql`)))
  const operationId = randomUUID()
  const agreementHash = keccak256(stringToHex(runId))
  const requester = deployment.requester.toLowerCase()
  const jobId = keccak256(stringToHex(runId + '-job'))
  await store.query(`INSERT INTO agreement_records
    (agreement_hash,job_id,version,domain,terms,scope,allocations,required_signers,state,created_at_ms)
    VALUES($1,$2,1,$3,$4,'{}','[]','[]','funded',$5)`,
  [agreementHash, jobId, JSON.stringify({ chainId: 31337, verifyingContract: deployment.jobEscrow }),
    JSON.stringify({ requester, materialCap: '3000000000000000000' }), Date.now()])
  await store.query(`INSERT INTO procurement_operations
    (operation_id,agreement_hash,job_id,requester,chain_instance,destination_hash,kits,max_cred,deadline,calldata,call_binding,status,created_at_ms,updated_at_ms)
    VALUES($1,$2,$3,$4,$5,$6,1,2000000000000000000,1,'0x',$6,'reserved',$7,$7)`,
  [operationId, agreementHash, jobId, requester, evm.instance, agreementHash, Date.now()])
  const service = createProcurementService({ store, evm, deployment, account: { address: requester } })
  assert.equal((await service.get(operationId)).status, 'reserved')
  assert.equal((await service.budget(agreementHash)).reserved, '2000000000000000000')
  report.checks.push({ name: 'bound-requester-can-read-own-operation-and-budget', status: 'pass' })

  const foreign = createProcurementService({ store, evm, deployment, account: { address: deployment.builder } })
  for (const action of ['get', 'broadcast', 'reconcile']) {
    await assert.rejects(foreign[action](operationId), { code: 'PROCUREMENT_OPERATION_CONTEXT' })
  }
  await assert.rejects(foreign.budget(agreementHash), { code: 'PROCUREMENT_AGREEMENT_CONTEXT' })
  report.checks.push({ name: 'other-requester-cannot-read-send-or-reconcile-original-operation', status: 'pass' })

  const otherChain = Object.create(evm)
  otherChain.instance = '31337:0x' + '00'.repeat(32)
  const mismatched = createProcurementService({ store, evm: otherChain, deployment, account: { address: requester } })
  await assert.rejects(mismatched.get(operationId), { code: 'PROCUREMENT_OPERATION_CONTEXT' })
  report.checks.push({ name: 'different-chain-instance-cannot-reuse-reserved-operation', status: 'pass' })
  report.status = 'pass'
} catch (error) {
  report.error = { code: error.code, message: error.message }
  process.exitCode = 1
} finally {
  await store.close()
  await administrator.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await administrator.close()
  report.finishedAt = new Date().toISOString()
  report.sourceSha256 = {}
  for (const name of ['backend/src/procurement/service.mjs', 'backend/src/procurement/schema.sql', 'tests/procurement/authorization.mjs']) {
    report.sourceSha256[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, chainReadOnly: true, evidence: path.relative(root, output), error: report.error }))
}
