import { createPublicClient, createWalletClient, http, keccak256, parseTransaction } from 'viem'

const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))

export class DurableEvm {
  constructor({ store, rpcUrl, genesisHash, chain }) {
    this.store = store
    this.rpcUrl = rpcUrl
    this.genesisHash = genesisHash
    this.chain = chain
    this.instance = `${chain.id}:${genesisHash}`
    this.client = createPublicClient({ chain, transport: this.transport() })
  }

  transport() { return http(this.rpcUrl, { retryCount: 0, timeout: 15000, fetchOptions: { headers: { 'User-Agent': 'AgentCity/0.1' } } }) }

  async validateRequest() {}

  async verify() {
    if (await this.client.getChainId() !== this.chain.id || (await this.client.getBlock({ blockNumber: 0n })).hash !== this.genesisHash) throw new Error('chain_instance_changed')
  }

  async prepare(operationId, account, destination, calldata, value = 0n) {
    await this.verify()
    const sender = account.address.toLowerCase()
    const to = destination ? destination.toLowerCase() : 'create'
    return this.store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operationId])
      const { rows: [existing] } = await tx.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])
      if (existing) {
        if (existing.chain_instance !== this.instance || existing.account !== sender || existing.destination !== to || existing.calldata !== calldata || BigInt(parseTransaction(existing.raw_transaction).value || 0n) !== value) throw new Error('transaction_binding_conflict')
        return existing
      }
      await tx.query('INSERT INTO ac_chain_nonces(chain_instance,account,next_nonce) VALUES($1,$2,0) ON CONFLICT DO NOTHING', [this.instance, sender])
      const { rows: [counter] } = await tx.query('SELECT next_nonce FROM ac_chain_nonces WHERE chain_instance=$1 AND account=$2 FOR UPDATE', [this.instance, sender])
      const nonce = Math.max(Number(counter.next_nonce), await this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }))
      if (!Number.isSafeInteger(nonce)) throw new Error('nonce_overflow')
      const wallet = createWalletClient({ account, chain: this.chain, transport: this.transport() })
      const request = await wallet.prepareTransactionRequest({ account, ...(destination ? { to: destination } : {}), data: calldata, value, nonce })
      await this.validateRequest(tx, request)
      const raw = await account.signTransaction(request)
      const hash = keccak256(raw)
      await tx.query('UPDATE ac_chain_nonces SET next_nonce=$3 WHERE chain_instance=$1 AND account=$2', [this.instance, sender, nonce + 1])
      return (await tx.query('INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [operationId, this.instance, sender, to, calldata, nonce, raw, hash])).rows[0]
    })
  }

  async broadcast(operationId) {
    await this.verify()
    const { rows: [intent] } = await this.store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])
    if (!intent || intent.chain_instance !== this.instance) throw new Error('unknown_transaction_intent')
    if (['confirmed', 'reverted', 'reorganized'].includes(intent.status)) {
      const current = await this.receipt(operationId)
      return { status: ['confirmed', 'reverted'].includes(current.status) ? 'submitted' : 'reconciliation_required', hash: intent.transaction_hash }
    }
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: intent.raw_transaction })
      if (hash !== intent.transaction_hash) throw new Error('transaction_hash_mismatch')
    } catch {
      // Retry only the original signed bytes; an uncertain send never creates another purchase.
      const existing = await this.client.getTransaction({ hash: intent.transaction_hash }).catch(() => null)
      if (!existing) {
        await this.store.query("UPDATE ac_chain_intents SET status='unknown' WHERE operation_id=$1", [operationId])
        return { status: 'unknown', hash: intent.transaction_hash }
      }
    }
    await this.store.query("UPDATE ac_chain_intents SET status='submitted' WHERE operation_id=$1", [operationId])
    return { status: 'submitted', hash: intent.transaction_hash }
  }

  async receipt(operationId, confirmations = 1) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('invalid_finality')
    await this.verify()
    const { rows: [intent] } = await this.store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])
    if (!intent || intent.chain_instance !== this.instance) throw new Error('unknown_transaction_intent')
    const receipt = await this.client.getTransactionReceipt({ hash: intent.transaction_hash }).catch(error => {
      if (error.name === 'TransactionReceiptNotFoundError') return null
      throw error
    })
    if (!receipt) {
      if (['confirmed', 'reverted', 'reorganized'].includes(intent.status)) {
        await this.store.query("UPDATE ac_chain_intents SET status='reorganized' WHERE operation_id=$1", [operationId])
        return { status: 'reorganized', hash: intent.transaction_hash }
      }
      return { status: 'pending', hash: intent.transaction_hash }
    }
    const canonical = await this.client.getBlock({ blockNumber: receipt.blockNumber })
    if (canonical.hash !== receipt.blockHash) {
      await this.store.query("UPDATE ac_chain_intents SET status='reorganized' WHERE operation_id=$1", [operationId])
      return { status: 'reorganized', hash: intent.transaction_hash }
    }
    if ((await this.client.getBlockNumber({ cacheTime: 0 })) - receipt.blockNumber + 1n < BigInt(confirmations)) return { status: 'confirming', hash: intent.transaction_hash }
    const status = receipt.status === 'success' ? 'confirmed' : 'reverted'
    await this.store.query('UPDATE ac_chain_intents SET status=$2,receipt=$3 WHERE operation_id=$1', [operationId, status, json(receipt)])
    return { status, hash: intent.transaction_hash, receipt }
  }
}
