import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { publishDemoDiscovery } from '../../backend/src/discovery/demo-discovery.mjs'
import { openTestnetRuntime } from '../../backend/src/chain/testnet-runtime.mjs'
import { createPublicArkivAdapter } from '../../backend/src/discovery/public-testnet.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { keccak256, stringToHex } = require('viem')
const root = new URL('../../', import.meta.url)
const runId = randomUUID()
const hash = value => keccak256(stringToHex(value))
const report = { status: 'fail', scope: 'Actual public Arkiv SDK integration with a disclosed synthetic agreement hash; agent-controlled wallets.', independentHumans: 0, realMoneySpentUsd: 0 }
try {
  report.discovery = await publishDemoDiscovery({ jobId: hash(runId), agreementHash: hash('synthetic-agreement-' + runId), serverId: hash('agentcity-separate-contract-demo-1301'),
    blueprintHash: '0x' + createHash('sha256').update(await readFile(new URL('fixtures/blueprints/calculator-v1.json', root))).digest('hex') })
  const runtime = await openTestnetRuntime(7738577)
  try {
    const { store, evm, accounts } = runtime
    const { rows: [offer] } = await store.query('SELECT * FROM discovery_publications WHERE entity_key=$1', [report.discovery.entities.offer])
    assert.ok(offer)
    const before = await evm.client.getTransactionCount({ address: accounts.builder.address, blockTag: 'pending' })
    // Simulate loss of the local result after the signed transaction already reached the chain.
    await store.query('UPDATE discovery_publications SET entity_key=NULL,transaction_hash=NULL WHERE digest=$1', [offer.digest])
    const adapter = createPublicArkivAdapter({ store, evm, account: accounts.builder })
    const recovered = await adapter.publish(offer.envelope)
    assert.equal(recovered.key, report.discovery.entities.offer)
    assert.equal(recovered.transactionHash, offer.transaction_hash)
    assert.equal(await evm.client.getTransactionCount({ address: accounts.builder.address, blockTag: 'pending' }), before)
    assert.equal((await adapter.get(recovered.key)).owner.toLowerCase(), accounts.builder.address.toLowerCase())
    report.lostResultRecovery = { status: 'pass', originalEntity: recovered.key, sameTransactionHash: recovered.transactionHash, extraTransactions: 0 }
  } finally { await runtime.close() }
  report.status = 'pass'
} catch (error) { report.error = { name: error.name, message: (error.shortMessage || error.message).slice(0, 1600) }; process.exitCode = 1 }
const output = new URL(`evidence/runs/public-arkiv/${runId}/`, root)
await mkdir(output, { recursive: true })
await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, evidence: output.pathname + 'report.json', error: report.error }))
