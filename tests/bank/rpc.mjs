import assert from 'node:assert/strict'
import { keccak256 } from '../../backend/node_modules/viem/_esm/index.js'
import { verifyBankRpcGraph, createBankRpcClient } from '../../backend/src/bank/rpc.mjs'

const hash = '0x' + '11'.repeat(32), genesis = '0x' + '22'.repeat(32), code = '0x6000'
const manifest = { chainId: 1301, genesisHash: genesis, bank: '0x' + '33'.repeat(20),
  codeHashes: { bank: keccak256(code) } }
function client(overrides = {}) {
  return { getChainId: async () => 1301, getBlock: async input => input?.blockNumber === 0n
    ? { number: 0n, hash: genesis } : { number: 10n, hash }, getBytecode: async () => code, ...overrides }
}
await verifyBankRpcGraph(client(), manifest)
await assert.rejects(verifyBankRpcGraph(client({ getChainId: async () => 1 }), manifest), /BANK_RPC_CHAIN_CHANGED/)
await assert.rejects(verifyBankRpcGraph(client(), { ...manifest, genesisHash: hash }), /BANK_RPC_GENESIS_CHANGED/)
await assert.rejects(verifyBankRpcGraph(client({ getBytecode: async () => '0x6001' }), manifest), /BANK_RPC_DEPLOYED_CODE_CHANGED/)
await assert.rejects(verifyBankRpcGraph(client({ getBlock: async input => input?.blockNumber === 0n
  ? { number: 0n, hash: genesis } : { number: 10n, hash: input ? genesis : hash } }), manifest), /BANK_RPC_BLOCK_CHANGED/)
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => { throw Error('Constructor must not make RPC calls') }
  await createBankRpcClient({ ...manifest, rpcUrl: 'https://sepolia.unichain.org' })
} finally { globalThis.fetch = originalFetch }
console.log(JSON.stringify({ status: 'pass', checks: 6, scope: 'RPC identity, deployed-graph and lazy verification fixtures; no public transaction.' }))
