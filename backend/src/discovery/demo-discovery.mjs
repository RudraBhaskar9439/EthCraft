import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hashTypedData } from 'viem'
import { openTestnetRuntime } from '../chain/testnet-runtime.mjs'
import { createPublicArkivAdapter } from './public-testnet.mjs'
import { createDiscoveryService, prepareDiscoveryRecord, discoveryTypedData } from './service.mjs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { acquireLocalLease } = require('./src/bot/checkpoint-store.cjs')
const root = new URL('../../../', import.meta.url)

export async function publishDemoDiscovery({ jobId, agreementHash, blueprintHash, serverId }) {
  const release = await acquireLocalLease('agentcity-public-arkiv-7738577')
  let runtime
  try {
    runtime = await openTestnetRuntime(7738577)
    const { evm, store, accounts } = runtime
    await store.migrate([new URL('backend/src/discovery/schema.sql', root)])
    await store.query('CREATE TABLE IF NOT EXISTS discovery_role_funding(role text PRIMARY KEY,operation_id uuid NOT NULL)')
    for (const role of ['requester', 'builder']) {
      const balance = await evm.client.getBalance({ address: accounts[role].address })
      if (balance >= 20000000000000000n) continue
      await store.query('INSERT INTO discovery_role_funding(role,operation_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, randomUUID()])
      const { rows: [funding] } = await store.query('SELECT * FROM discovery_role_funding WHERE role=$1', [role])
      await evm.prepare(funding.operation_id, accounts.admin, accounts[role].address, '0x', 20000000000000000n)
      await evm.broadcast(funding.operation_id)
      assert.equal((await evm.receipt(funding.operation_id)).status, 'confirmed')
    }
    const namespace = 'agentcity-contract-demo-' + jobId
    const context = { namespace, serverId, chainId: 7738577, blueprintHash }
    const resolveJob = async id => id === jobId ? { requester: accounts.requester.address, agreementHash, blueprintHash } : null
    const adapter = account => createPublicArkivAdapter({ store, evm, account })
    const requester = createDiscoveryService({ store, adapter: adapter(accounts.requester), context, resolveJob })
    const builder = createDiscoveryService({ store, adapter: adapter(accounts.builder), context, resolveJob })
    async function publish(service, account, kind, payload) {
      const id = kind + '-' + jobId
      const prior = (await store.query('SELECT envelope FROM discovery_publications WHERE envelope->\'record\'->>\'namespace\'=$1 AND envelope->\'record\'->>\'id\'=$2', [namespace, id])).rows[0]
      let envelope = prior?.envelope
      if (!envelope) {
        const now = Date.now()
        const record = prepareDiscoveryRecord({ namespace, serverId, chainId: 7738577, id, version: 1, owner: account.address, jobId: kind === 'profile' ? '0x' + '00'.repeat(32) : jobId,
          kind, payload, issuedAtMs: now, expiresAtMs: now + 3600000, withdrawn: false })
        envelope = { record, signature: await account.signTypedData(discoveryTypedData(record)) }
      }
      const result = await service.publish(envelope)
      return { ...result, digest: hashTypedData(discoveryTypedData(envelope.record)) }
    }
    const profile = await publish(builder, accounts.builder, 'profile', { displayName: 'Contract demo builder', service: 'calculator-v1', blueprintHash })
    const job = await publish(requester, accounts.requester, 'job', { agreementHash, blueprintHash })
    const offer = await publish(builder, accounts.builder, 'offer', { profileKey: profile.key, agreementHash, blueprintHash, laborAmount: '6000000000000000000' })
    const selected = await requester.selectOffer(offer.key, jobId)
    assert.equal(selected.envelope.record.owner, accounts.builder.address.toLowerCase())
    assert.equal((await builder.publish(offer.envelope)).key, offer.key)
    return { status: 'pass', chainId: 7738577, namespace, serverId, jobId, agreementHash, blueprintHash,
      entities: { profile: profile.key, job: job.key, offer: offer.key },
      transactions: [profile.transactionHash, job.transactionHash, offer.transactionHash].filter(Boolean),
      checks: ['official SDK public profile, job and offer publication', 'actual Arkiv owner and signed agreement binding', 'same publication reuses its retained entity'],
      independentHumans: 0, scope: 'Agent-controlled test wallets; independent synthetic contract demonstration' }
  } finally { if (runtime) await runtime.close(); await release() }
}
