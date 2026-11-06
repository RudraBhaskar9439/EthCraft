import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DurableEvm } from '../../backend/src/chain/durable-evm.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { foundry } = require('viem/chains')
const operationId = '0944ce27-2918-4429-9f3c-de2a2e6b4a64'
const genesisHash = '0x' + '11'.repeat(32)
const hash = '0x' + '22'.repeat(32)
const intent = { operation_id: operationId, chain_instance: `31337:${genesisHash}`, status: 'submitted', transaction_hash: hash, raw_transaction: '0x01' }
const store = { query: async (sql, parameters) => {
  assert.equal(parameters[0], operationId)
  if (sql.startsWith('SELECT * FROM ac_chain_intents')) return { rows: [{ ...intent }] }
  assert.equal(sql, "UPDATE ac_chain_intents SET status='reorganized' WHERE operation_id=$1")
  intent.status = 'reorganized'
  return { rows: [] }
} }
const evm = new DurableEvm({ store, rpcUrl: 'http://127.0.0.1:1', genesisHash, chain: foundry })
let sends = 0
evm.client = {
  getChainId: async () => 31337,
  getBlock: async ({ blockNumber }) => ({ hash: blockNumber === 0n ? genesisHash : '0x' + '33'.repeat(32) }),
  getTransactionReceipt: async () => ({ transactionHash: hash, blockNumber: 7n, blockHash: '0x' + '44'.repeat(32), status: 'success' }),
  sendRawTransaction: async () => { sends++; throw new Error('reorganized_intent_must_not_broadcast') }
}

assert.equal((await evm.receipt(operationId)).status, 'reorganized')
assert.equal(intent.status, 'reorganized', 'Canonical block mismatch must persist the replay fence.')
assert.deepEqual(await evm.broadcast(operationId), { status: 'reconciliation_required', hash })
assert.equal(sends, 0)
console.log(JSON.stringify({ status: 'pass', check: 'canonical-block-mismatch-persists-reorganization-and-prevents-rebroadcast', rawTransactionSends: sends }))
