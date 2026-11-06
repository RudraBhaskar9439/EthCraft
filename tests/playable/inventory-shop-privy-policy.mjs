import assert from 'node:assert/strict'
import { buildInventoryShopPrivyPolicy } from '../../scripts/inventory_shop_privy_setup.mjs'
import { privyPolicyFingerprint } from '../../backend/src/playable/testnet-wallets.mjs'

const manifest = { schema: 'agentcity.world-assets.v1', environment: 'UNICHAIN_SEPOLIA_WORLD_ASSETS', chainId: 1301,
  rpcUrl: 'https://sepolia.unichain.org', city: '0x' + '1'.repeat(40), market: '0x' + '2'.repeat(40),
  registry: '0x' + '3'.repeat(40), maxPriceBaseUnits: String(100n * 10n ** 18n),
  codeHashes: Object.fromEntries(['city', 'market', 'registry'].map(name => [name, '0x' + 'a'.repeat(64)])) }
const { player, allowedTargets } = buildInventoryShopPrivyPolicy(manifest)
assert.equal(player.rules.length, 3)
assert.deepEqual(new Set(allowedTargets), new Set([manifest.city, manifest.market, manifest.registry]))
const methods = []
for (const rule of player.rules) {
  assert.equal(rule.action, 'ALLOW'); assert.equal(rule.method, 'eth_signTransaction')
  const transaction = field => rule.conditions.find(condition => condition.field_source === 'ethereum_transaction' && condition.field === field)
  assert.equal(transaction('chain_id').operator, 'eq'); assert.equal(transaction('chain_id').value, '1301')
  assert.equal(transaction('value').value, '0')
  const method = rule.conditions.find(condition => condition.field_source === 'ethereum_calldata').abi[0].name
  methods.push(method)
  assert.equal(transaction('to').value, ({ approve: manifest.city, buy: manifest.market, requestRedemption: manifest.registry })[method])
  const bound = field => rule.conditions.find(condition => condition.field === field && condition.operator === 'lte')
  if (method === 'approve') {
    assert.equal(rule.conditions.find(condition => condition.field === 'approve.spender').value, manifest.market)
    assert.equal(bound('approve.amount').value, '1000000000000000000')
  }
  if (method === 'buy') assert.equal(bound('buy.expectedPrice').value, '1000000000000000000')
}
assert.deepEqual(methods.sort(), ['approve', 'buy', 'requestRedemption'])
assert.equal(privyPolicyFingerprint(player), privyPolicyFingerprint(buildInventoryShopPrivyPolicy(manifest).player))
assert.throws(() => buildInventoryShopPrivyPolicy({ ...manifest, chainId: 1 }), /PINNED_PUBLIC_MANIFEST_REQUIRED/)
assert.throws(() => buildInventoryShopPrivyPolicy({ ...manifest, registry: manifest.city }), /DISTINCT_DEPLOYMENTS_REQUIRED/)
console.log('PASS buyer-only Privy policy has exactly CITY approval, capped purchase and item redemption on the current testnet targets; no listing, cancel, NFT approval, swap or lending authority')
