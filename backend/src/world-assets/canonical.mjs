import { createHash } from 'node:crypto'
import { getAddress, keccak256, parseEventLogs, zeroAddress } from 'viem'
import { registryAbi, assetMarketAbi, cityAbi } from './abis.mjs'

export const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
export const stable = value => JSON.stringify(json(value), (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort()) : item)
export const digest = value => createHash('sha256').update(stable(value)).digest('hex')
export const lower = value => getAddress(value).toLowerCase()
export const hex32 = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
const error = code => { throw Error(code) }

export function validateWorldAssetManifest(input, { allowLocalFixture = false } = {}) {
  const m = structuredClone(input), local = m?.environment === 'LOCAL_TEST_FIXTURE' && allowLocalFixture && [1301, 31337].includes(m.chainId) && /^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(m.rpcUrl || '')
  if (m?.schema !== 'agentcity.world-assets.v1' || !local && !(m.environment === 'UNICHAIN_SEPOLIA_WORLD_ASSETS' && m.chainId === 1301 && m.rpcUrl === 'https://sepolia.unichain.org') || !hex32(m.genesisHash) || !hex32(m.serverId) || !hex32(m.deploymentId) || m.confirmations !== 2) error('WORLD_ASSET_PINNED_MANIFEST_REQUIRED')
  for (const field of ['registry', 'market', 'city']) { m[field] = lower(m[field]); if (m[field] === zeroAddress || !hex32(m.codeHashes?.[field])) error('WORLD_ASSET_DEPLOYMENT_PIN_REQUIRED') }
  if (new Set([m.registry, m.market, m.city]).size !== 3) error('WORLD_ASSET_DISTINCT_DEPLOYMENTS_REQUIRED')
  for (const field of ['maxPriceBaseUnits', 'maxGas', 'maxNativeCostWei']) if (!/^[1-9][0-9]*$/.test(m[field] || '')) error('WORLD_ASSET_EXPLICIT_LIMITS_REQUIRED')
  const maxGas = Number(m.maxGas)
  if (!Number.isSafeInteger(maxGas) || maxGas < 21000 || maxGas > 1000000 || BigInt(m.maxNativeCostWei) > 8000000000000000n) error('WORLD_ASSET_MANAGED_WALLET_BUDGET_REQUIRED')
  if (BigInt(m.maxPriceBaseUnits) > (1n << 128n) - 1n) error('WORLD_ASSET_PRICE_CAP_INVALID')
  return m
}

export function createCanonicalReader({ client, manifest, now = Date.now }) {
  async function verify() {
    if (await client.getChainId() !== manifest.chainId || (await client.getBlock({ blockNumber: 0n })).hash.toLowerCase() !== manifest.genesisHash.toLowerCase()) error('WORLD_ASSET_CHAIN_INSTANCE_CHANGED')
    for (const name of ['registry', 'market', 'city']) {
      const code = await client.getCode({ address: manifest[name] })
      if (!code || code === '0x' || keccak256(code).toLowerCase() !== manifest.codeHashes[name].toLowerCase()) error('WORLD_ASSET_CODE_CHANGED')
    }
    const [registry, city] = await Promise.all(['registry', 'city'].map(functionName => client.readContract({ address: manifest.market, abi: assetMarketAbi, functionName })))
    if (lower(registry) !== manifest.registry || lower(city) !== manifest.city) error('WORLD_ASSET_MARKET_BINDING_CHANGED')
    const [symbol, decimals] = await Promise.all(['symbol', 'decimals'].map(functionName => client.readContract({ address: manifest.city, abi: cityAbi, functionName })))
    if (symbol !== 'CITY' || Number(decimals) !== 18) error('WORLD_ASSET_PAYMENT_TOKEN_CHANGED')
  }
  async function snapshot(previous) {
    await verify()
    const head = await client.getBlockNumber({ cacheTime: 0 })
    if (head < 1n) error('WORLD_ASSET_WAIT_FOR_TWO_CONFIRMATIONS')
    if (previous) {
      if (head < BigInt(previous.blockNumber) || (await client.getBlock({ blockNumber: BigInt(previous.blockNumber) })).hash.toLowerCase() !== previous.blockHash.toLowerCase()) error('WORLD_ASSET_CANONICAL_REORG')
    }
    const block = await client.getBlock({ blockNumber: head - 1n })
    if (!block.hash || now() - Number(block.timestamp) * 1000 > 45000 || Number(block.timestamp) * 1000 > now() + 5000) error('WORLD_ASSET_RPC_STALE')
    return { blockNumber: block.number, blockHash: block.hash, timestamp: Number(block.timestamp), confirmations: 2, observedAtMs: now() }
  }
  async function unchanged(block) {
    if ((await client.getBlock({ blockNumber: BigInt(block.blockNumber) })).hash.toLowerCase() !== block.blockHash.toLowerCase()) error('WORLD_ASSET_CANONICAL_REORG')
  }
  async function asset(tokenId, block) {
    const value = await client.readContract({ address: manifest.registry, abi: registryAbi, functionName: 'asset', args: [BigInt(tokenId)], blockNumber: BigInt(block.blockNumber) })
    if (value.serverId.toLowerCase() !== manifest.serverId.toLowerCase()) error('WORLD_ASSET_SERVER_BINDING_CHANGED')
    const owner = value.redeemed ? null : lower(await client.readContract({ address: manifest.registry, abi: registryAbi, functionName: 'ownerOf', args: [BigInt(tokenId)], blockNumber: BigInt(block.blockNumber) }))
    await unchanged(block)
    return json({ ...value, owner, tokenId: String(tokenId) })
  }
  async function transaction({ transactionHash, from, to, data, eventName, match = {}, abi: suppliedAbi }) {
    const block = await snapshot(), receipt = await client.getTransactionReceipt({ hash: transactionHash })
    if (receipt.status !== 'success') error('WORLD_ASSET_TRANSACTION_REVERTED')
    if (BigInt(receipt.blockNumber) > BigInt(block.blockNumber)) return { confirmed: false, transactionHash, reason: 'Waiting for two canonical confirmations.' }
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
    if (canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) error('WORLD_ASSET_CANONICAL_REORG')
    const tx = await client.getTransaction({ hash: transactionHash })
    if (lower(tx.from) !== lower(from) || lower(tx.to) !== lower(to) || tx.input.toLowerCase() !== data.toLowerCase() || BigInt(tx.value) !== 0n) error('WORLD_ASSET_TRANSACTION_BINDING_CHANGED')
    const abi = suppliedAbi || (lower(to) === manifest.registry ? registryAbi : assetMarketAbi)
    const logs = eventName ? parseEventLogs({ abi, eventName, logs: receipt.logs.filter(log => lower(log.address) === lower(to)), strict: true }) : []
    const log = eventName ? logs.find(log => Object.entries(match).every(([key, value]) => String(log.args[key]).toLowerCase() === String(value).toLowerCase())) : null
    if (eventName && !log) error('WORLD_ASSET_EXACT_EVENT_REQUIRED')
    await unchanged(block)
    return json({ confirmed: true, chainId: manifest.chainId, registry: manifest.registry, deploymentId: manifest.deploymentId, transactionHash,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, confirmations: Number((BigInt(block.blockNumber) + 1n) - BigInt(receipt.blockNumber) + 1n),
      observedAtMs: now(), logIndex: log?.logIndex ?? null, eventName: log?.eventName ?? null, args: log?.args ?? {}, receiptHash: digest(receipt), logHash: log ? digest(log) : null })
  }
  async function ownershipProof(tokenId, current, fromBlock, block) {
    const event = registryAbi.find(value => value.type === 'event' && value.name === 'AssetOwnershipChanged')
    const logs = await client.getLogs({ address: manifest.registry, event, args: { tokenId: BigInt(tokenId) }, fromBlock: BigInt(fromBlock), toBlock: BigInt(block.blockNumber) })
    const log = logs.reverse().find(value => !value.removed && lower(value.args.to) === current.owner && String(value.args.ownershipNonce) === current.ownershipNonce && String(value.args.revision) === current.revision)
    if (!log) return null
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash }), canonical = await client.getBlock({ blockNumber: log.blockNumber })
    if (receipt.status !== 'success' || receipt.blockHash !== log.blockHash || canonical.hash !== log.blockHash || !receipt.logs.some(value => value.logIndex === log.logIndex && lower(value.address) === manifest.registry)) error('WORLD_ASSET_OWNERSHIP_EVENT_BINDING_CHANGED')
    await unchanged(block)
    return json({ confirmed: true, transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
      confirmations: Number(BigInt(block.blockNumber) + 2n - BigInt(log.blockNumber)), eventName: 'AssetOwnershipChanged', args: log.args,
      receiptHash: digest(receipt), logHash: digest(log), logIndex: log.logIndex })
  }
  return { verify, snapshot, unchanged, asset, transaction, ownershipProof, client }
}
