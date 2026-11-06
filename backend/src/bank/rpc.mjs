import { createPublicClient, http, fallback, custom, keccak256 } from 'viem'

const PUBLIC_NODE = 'https://unichain-sepolia-rpc.publicnode.com'
const verified = new Map()
const fail = code => { throw Object.assign(Error(code), { code }) }

export async function verifyBankRpcGraph(client, manifest) {
  if (await client.getChainId() !== manifest.chainId) fail('BANK_RPC_CHAIN_CHANGED')
  const genesis = await client.getBlock({ blockNumber: 0n })
  if (genesis.hash.toLowerCase() !== manifest.genesisHash.toLowerCase()) fail('BANK_RPC_GENESIS_CHANGED')
  const anchor = await client.getBlock()
  await Promise.all(Object.entries(manifest.codeHashes).map(async ([name, expected]) => {
    const code = await client.getBytecode({ address: manifest[name], blockNumber: anchor.number })
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== expected.toLowerCase()) fail('BANK_RPC_DEPLOYED_CODE_CHANGED')
  }))
  const retained = await client.getBlock({ blockNumber: anchor.number })
  if (retained.hash !== anchor.hash) fail('BANK_RPC_BLOCK_CHANGED')
}

export async function createBankRpcClient(manifest) {
  const primary = http(manifest.rpcUrl, { retryCount: 0, timeout: 6000 })
  if (manifest.chainId !== 1301) return createPublicClient({ transport: primary })
  const key = JSON.stringify([manifest.chainId, manifest.genesisHash,
    Object.entries(manifest.codeHashes).map(([name, hash]) => [name, manifest[name], hash])])
  const ensureVerified = async () => {
    if (!verified.has(key)) {
      const probe = createPublicClient({ transport: http(PUBLIC_NODE, { retryCount: 1, timeout: 10000 }) })
      const verification = verifyBankRpcGraph(probe, manifest).catch(error => { verified.delete(key); throw error })
      verified.set(key, verification)
    }
    await verified.get(key)
  }
  // The manifest remains unchanged because retained confirmations bind its digest.
  const client = createPublicClient({ transport: fallback([primary,
    http(PUBLIC_NODE, { retryCount: 0, timeout: 12000 })], { rank: false, retryCount: 0 }) })
  return createPublicClient({ transport: custom({ request: async request => {
    await ensureVerified()
    return client.request(request)
  } }, { retryCount: 0 }) })
}
