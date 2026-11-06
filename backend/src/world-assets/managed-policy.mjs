import { getAddress } from 'viem'
import { registryAbi, assetMarketAbi, cityAbi } from './abis.mjs'

export function buildPrivyWorldAssetPolicies(manifest) {
  const address = value => getAddress(value).toLowerCase()
  if (manifest?.schema !== 'agentcity.world-assets.v1' || manifest.environment !== 'UNICHAIN_SEPOLIA_WORLD_ASSETS' || manifest.chainId !== 1301 || manifest.rpcUrl !== 'https://sepolia.unichain.org' || !/^[1-9][0-9]*$/.test(manifest.maxPriceBaseUnits || '') || BigInt(manifest.maxPriceBaseUnits) > (1n << 128n) - 1n) throw Error('WORLD_ASSET_PINNED_PUBLIC_MANIFEST_REQUIRED')
  const registry = address(manifest.registry), market = address(manifest.market), city = address(manifest.city)
  if (new Set([registry, market, city]).size !== 3 || [registry, market, city].some(value => /^0x0{40}$/.test(value))) throw Error('WORLD_ASSET_DISTINCT_DEPLOYMENTS_REQUIRED')
  for (const key of ['registry', 'market', 'city']) if (!/^0x[0-9a-f]{64}$/i.test(manifest.codeHashes?.[key] || '')) throw Error('WORLD_ASSET_CODE_HASH_REQUIRED')
  const transaction = (field, value) => ({ field_source: 'ethereum_transaction', field, operator: 'eq', value })
  const base = to => [transaction('chain_id', '1301'), transaction('to', to), transaction('value', '0')]
  const parameter = (abi, name, field, operator, value) => ({ field_source: 'ethereum_calldata', abi: abi.filter(item => item.type === 'function' && item.name === name), field: `${name}.${field}`, operator, value })
  const rule = (name, to, conditions) => ({ name, method: 'eth_signTransaction', action: 'ALLOW', conditions: [...base(to), ...conditions] })
  const player = { version: '1.0', chain_type: 'ethereum', rules: [
    rule('Capped CITY approval to world asset market', city, [parameter(cityAbi, 'approve', 'spender', 'eq', market), parameter(cityAbi, 'approve', 'amount', 'lte', manifest.maxPriceBaseUnits)]),
    rule('One NFT approval to world asset market', registry, [parameter(registryAbi, 'approve', 'to', 'eq', market), parameter(registryAbi, 'approve', 'tokenId', 'gte', '1')]),
    rule('Owner item redemption request only', registry, [parameter(registryAbi, 'requestRedemption', 'tokenId', 'gte', '1')]),
    rule('Capped world asset listing', market, [parameter(assetMarketAbi, 'list', 'price', 'gte', '1'), parameter(assetMarketAbi, 'list', 'price', 'lte', manifest.maxPriceBaseUnits)]),
    rule('Capped exact world asset purchase', market, [parameter(assetMarketAbi, 'buy', 'expectedPrice', 'gte', '1'), parameter(assetMarketAbi, 'buy', 'expectedPrice', 'lte', manifest.maxPriceBaseUnits)]),
    rule('Cancel one world asset listing', market, [parameter(assetMarketAbi, 'cancel', 'tokenId', 'gte', '1')])
  ] }
  return { player, allowedTargets: [registry, market, city] }
}
