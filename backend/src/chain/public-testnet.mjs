import { parseTransaction } from 'viem'
import { unichainSepolia } from 'viem/chains'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { DurableEvm } from './durable-evm.mjs'

// These are faucet test ETH limits, not authorization to spend real funds.
export const TESTNET_NATIVE_CAP = 8000000000000000n
const networks = {
  1301: { chain: unichainSepolia, rpc: 'https://sepolia.unichain.org', cap: TESTNET_NATIVE_CAP },
  7738577: { chain: tiramisu, rpc: 'https://rpc.tiramisu.db-chain.testnet.arkiv.network', cap: 100000000000000000n }
}

export class PublicTestnetEvm extends DurableEvm {
  constructor(options) {
    const network = networks[options.chainId]
    if (!network || options.rpcUrl !== network.rpc ||
        !(options.environment === 'PUBLIC_TESTNET_SYNTHETIC_ONLY' || options.chainId === 1301 && options.environment === 'PUBLIC_TESTNET_WORLD_ASSETS') || !Array.isArray(options.allowedSigners) || !options.allowedSigners.length ||
        options.allowedSigners.some(address => typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address))) {
      throw new Error('public_testnet_configuration_required')
    }
    super({ ...options, chain: network.chain })
    this.nativeCap = network.cap
    this.allowedSigners = new Set(options.allowedSigners.map(address => address.toLowerCase()))
  }

  async prepare(operationId, account, destination, calldata, value = 0n) {
    if (!this.allowedSigners.has(account.address.toLowerCase()) || typeof value !== 'bigint' || value < 0n) throw new Error('testnet_signer_or_value_denied')
    return super.prepare(operationId, account, destination, calldata, value)
  }

  async validateRequest(tx, request) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['agentcity-testnet-native-budget:' + this.instance])
    const { rows } = await tx.query('SELECT raw_transaction FROM ac_chain_intents WHERE chain_instance=$1', [this.instance])
    const maximumCost = transaction => BigInt(transaction.gas) * BigInt(transaction.maxFeePerGas ?? transaction.gasPrice) + BigInt(transaction.value || 0n)
    const reserved = rows.reduce((sum, row) => sum + maximumCost(parseTransaction(row.raw_transaction)), 0n)
    if (reserved + maximumCost(request) > this.nativeCap) throw new Error('testnet_native_budget_exhausted')
  }

  async receipt(operationId, confirmations = 2) {
    const { rows: [intent] } = await this.store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (intent?.chain_instance === this.instance && ['submitted', 'unknown'].includes(intent.status)) {
          await this.client.waitForTransactionReceipt({ hash: intent.transaction_hash, confirmations, timeout: 15000, pollingInterval: 1000 })
        }
        return await super.receipt(operationId, confirmations)
      } catch (error) {
        if (error.name !== 'BlockNotFoundError' || attempt === 3) throw error
        // A lagging RPC reader must not turn a retained transaction into a fresh send.
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }
}
