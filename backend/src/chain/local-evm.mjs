import { foundry } from 'viem/chains'
import { DurableEvm } from './durable-evm.mjs'

export class LocalEvm extends DurableEvm {
  constructor(options) {
    const url = new URL(options.rpcUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('local_chain_required')
    super({ ...options, chain: foundry })
  }
}
