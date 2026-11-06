import { randomUUID } from 'node:crypto'
import { encodeFunctionData } from 'viem'
import { json } from '../world-assets/canonical.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }

/** Persist the full report before signing so retries never change its expiry. */
export function createBankHealthPublisher({ store, manifest, client, abi, publisher, reader, native, now = Date.now }) {
  const deployment = manifest.deploymentId, key = 'bank:health-publication'
  const save = value => store.put(deployment, key, json(value))
  async function status() {
    const [onchain, expiry] = await Promise.all(['available', 'validUntil'].map(functionName =>
      client.readContract({ address: manifest.stateRegistry, abi, functionName })))
    const validUntil = Number(expiry), available = onchain === true && validUntil > Math.floor(now() / 1000)
    return { available, validUntil, message: available
      ? 'Fresh world report. CITY purchases are available until ' + new Date(validUntil * 1000).toISOString() + '.'
      : 'CITY purchases are paused pending a fresh world report. CITY-to-USDC exits and direct loan repayment remain available.' }
  }
  async function publish() {
    return store.lock(deployment, key, async () => {
      let retained = await store.get(deployment, key)
      if (retained?.status !== 'pending') {
        const world = await native('status'), healthy = world.available === true, current = await status()
        if (current.available === healthy && current.validUntil > Math.floor(now() / 1000) + 150) return current
        const sequence = await client.readContract({ address: manifest.stateRegistry, abi, functionName: 'sequence' })
        const block = await client.getBlock(), validUntil = Number(block.timestamp) + 300
        retained = { operationId: randomUUID(), sequence: String(sequence + 1n), healthy, validUntil, status: 'pending',
          data: encodeFunctionData({ abi, functionName: 'publish', args: [sequence + 1n, healthy, validUntil] }) }
        await save(retained)
      }
      const { operationId, data } = retained
      await publisher.prepare({ operationId, to: manifest.stateRegistry, data, value: 0n,
        limits: { maxGas: manifest.maxGas, maxNativeCostWei: manifest.maxNativeCostWei } })
      await publisher.broadcast({ operationId })
      const result = await publisher.reconcile({ operationId })
      if (result.status === 'reverted' || result.receipt?.status === 'reverted') {
        const failed = { ...retained, status: 'reverted', transactionHash: result.transactionHash || result.hash }
        await store.put(deployment, key + ':' + operationId, failed)
        await save(failed)
        fail('BANK_HEALTH_REVERT_RECORDED_REFRESH_TO_RETRY')
      }
      const hash = result.transactionHash || result.hash
      if (!hash) return { ...await status(), pending: true, message: 'The original health publication is pending. Reconcile it before creating another report.' }
      const proof = await reader.transaction({ transactionHash: hash, from: manifest.roles.publisher,
        to: manifest.stateRegistry, data, eventName: 'StatePublished',
        match: { sequence: retained.sequence, healthy: retained.healthy, validUntil: retained.validUntil }, abi })
      if (!proof.confirmed) return { ...await status(), pending: true, message: proof.reason }
      const completed = { ...retained, status: 'confirmed', proof }
      await store.put(deployment, key + ':' + operationId, completed)
      await save(completed)
      return status()
    })
  }
  return { status, publish }
}
