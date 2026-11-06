import { randomUUID } from 'node:crypto'
import { createPublicClient, createWalletClient } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { custom, http, hashTypedData, keccak256, parseTransaction, recoverTransactionAddress } from 'viem'
import { createArkivDiscoveryAdapter } from './adapters.mjs'
import { discoveryTypedData } from './service.mjs'

const rpcUrl = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network'
export function createPublicArkivAdapter({ store, evm, account }) {
  if (evm.chain.id !== 7738577 || evm.rpcUrl !== rpcUrl) throw new Error('tiramisu_testnet_required')
  const publicClient = createPublicClient({ chain: tiramisu, transport: http(rpcUrl, { retryCount: 0, fetchOptions: { headers: { 'User-Agent': 'AgentCity/0.1' } } }) })
  const reader = createArkivDiscoveryAdapter({ publicClient })
  const owner = account.address.toLowerCase()
  return {
    ...reader, owner,
    async publish(envelope) {
      if (envelope.record.chainId !== 7738577 || envelope.record.owner.toLowerCase() !== owner) throw new Error('publication_owner_or_network_changed')
      const digest = hashTypedData(discoveryTypedData(envelope.record))
      await store.query('INSERT INTO discovery_publications(digest,operation_id,owner,envelope) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [digest, randomUUID(), owner, envelope])
      const { rows: [publication] } = await store.query('SELECT * FROM discovery_publications WHERE digest=$1', [digest])
      if (publication.owner !== owner || hashTypedData(discoveryTypedData(publication.envelope.record)) !== digest) throw new Error('publication_owner_changed')
      if (publication.entity_key) return { key: publication.entity_key, transactionHash: publication.transaction_hash }
      const prior = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [publication.operation_id])).rows[0]
      if (prior) {
        await evm.broadcast(publication.operation_id)
        if ((await evm.receipt(publication.operation_id)).status !== 'confirmed') throw new Error('publication_confirmation_pending')
        for (let attempt = 0; attempt < 5; attempt++) {
          const found = await reader.search({ namespace: envelope.record.namespace, serverId: envelope.record.serverId, id: envelope.record.id })
          const entity = found.find(entity => entity.owner.toLowerCase() === owner && entity.envelope && hashTypedData(discoveryTypedData(entity.envelope.record)) === digest)
          if (entity) {
            await store.query('UPDATE discovery_publications SET entity_key=$2,transaction_hash=$3 WHERE digest=$1', [digest, entity.key, prior.transaction_hash])
            return { key: entity.key, transactionHash: prior.transaction_hash }
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        throw new Error('publication_index_reconciliation_pending')
      }
      const ordinary = http(rpcUrl, { retryCount: 0, fetchOptions: { headers: { 'User-Agent': 'AgentCity/0.1' } } })({ chain: tiramisu })
      const transport = custom({ request: async request => {
        if (request.method !== 'eth_sendRawTransaction') return ordinary.request(request)
        const raw = request.params[0]
        const signed = parseTransaction(raw)
        if (signed.chainId !== 7738577 || !signed.to || !Number.isSafeInteger(signed.nonce) || BigInt(signed.value || 0n) !== 0n || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== owner) throw new Error('publication_transaction_denied')
        await store.transaction(async tx => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [publication.operation_id])
          const existing = (await tx.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [publication.operation_id])).rows[0]
          if (existing) throw new Error('publication_already_prepared')
          await tx.query('INSERT INTO ac_chain_nonces(chain_instance,account,next_nonce) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [evm.instance, owner, signed.nonce])
          const { rows: [counter] } = await tx.query('SELECT next_nonce FROM ac_chain_nonces WHERE chain_instance=$1 AND account=$2 FOR UPDATE', [evm.instance, owner])
          if (Number(counter.next_nonce) > signed.nonce) throw new Error('publication_nonce_requires_reconciliation')
          await evm.validateRequest(tx, signed)
          const hash = keccak256(raw)
          await tx.query('INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [publication.operation_id, evm.instance, owner, signed.to.toLowerCase(), signed.data || '0x', signed.nonce, raw, hash])
          await tx.query('INSERT INTO ac_chain_nonces(chain_instance,account,next_nonce) VALUES($1,$2,$3) ON CONFLICT(chain_instance,account) DO UPDATE SET next_nonce=GREATEST(ac_chain_nonces.next_nonce,EXCLUDED.next_nonce)', [evm.instance, owner, signed.nonce + 1])
        })
        const result = await evm.broadcast(publication.operation_id)
        if (result.status !== 'submitted') throw new Error('publication_submission_unknown')
        return result.hash
      } }, { retryCount: 0 })
      const walletClient = createWalletClient({ account, chain: tiramisu, transport })
      const result = await createArkivDiscoveryAdapter({ publicClient, walletClient }).publish(envelope)
      if ((await evm.receipt(publication.operation_id)).status !== 'confirmed') throw new Error('publication_confirmation_pending')
      await store.query('UPDATE discovery_publications SET entity_key=$2,transaction_hash=$3 WHERE digest=$1', [digest, result.key, result.transactionHash])
      return result
    }
  }
}
