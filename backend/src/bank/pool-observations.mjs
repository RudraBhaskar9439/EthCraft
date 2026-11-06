import { randomUUID } from 'node:crypto'
import { encodeFunctionData } from 'viem'
import { json } from '../world-assets/canonical.mjs'

/** A lost checkpoint reply must reconcile the original transaction. */
export function createPoolObservationPublisher({ store, manifest, reader, publisher, abi }) {
  const key = 'marketplace:pool-observation', deployment = manifest.deploymentId
  const save = value => store.put(deployment, key, json(value))
  return async function publish() {
    return store.lock(deployment, key, async () => {
      let retained = await store.get(deployment, key)
      if (retained?.status !== 'pending') {
        retained = { operationId: randomUUID(), status: 'pending',
          data: encodeFunctionData({ abi, functionName: 'checkpoint' }) }
        await save(retained)
      }
      const { operationId, data } = retained
      await publisher.prepare({ operationId, to: manifest.hook, data, value: 0n,
        limits: { maxGas: manifest.maxGas, maxNativeCostWei: manifest.maxNativeCostWei } })
      await publisher.broadcast({ operationId })
      const result = await publisher.reconcile({ operationId })
      if (result.status === 'reverted' || result.receipt?.status === 'reverted') {
        const failed = { ...retained, status: 'reverted', transactionHash: result.transactionHash || result.hash }
        await store.put(deployment, key + ':' + operationId, json(failed))
        await save(failed)
        throw Object.assign(Error('MARKETPLACE_CHECKPOINT_REVERT_RECORDED'), { code: 'MARKETPLACE_CHECKPOINT_REVERT_RECORDED' })
      }
      const hash = result.transactionHash || result.hash
      if (!hash) return { pending: true, message: 'The original pool observation is pending. Reconcile it before starting another.' }
      const proof = await reader.transaction({ transactionHash: hash, from: manifest.roles.publisher,
        to: manifest.hook, data, abi })
      if (!proof.confirmed) return { pending: true, message: proof.reason }
      const completed = { ...retained, status: 'confirmed', proof }
      await store.put(deployment, key + ':' + operationId, json(completed))
      await save(completed)
      return { pending: false, proof, message: 'Actual pool state recorded. Elapsed time and sufficient liquidity are still required for a mature reference.' }
    })
  }
}
