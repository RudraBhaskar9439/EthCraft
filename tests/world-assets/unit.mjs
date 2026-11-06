import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildPrivyWorldAssetPolicies } from '../../backend/src/world-assets/managed-policy.mjs'
import { createCanonicalReader, validateWorldAssetManifest } from '../../backend/src/world-assets/canonical.mjs'
import { createWorldAssetStore } from '../../backend/src/world-assets/store.mjs'
import { createWorldAssets } from '../../backend/src/world-assets/service.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url)), { keccak256 } = require('viem')
const hash = byte => '0x' + byte.repeat(64), address = byte => '0x' + byte.repeat(40), code = '0x60006000'
const manifest = { schema: 'agentcity.world-assets.v1', environment: 'UNICHAIN_SEPOLIA_WORLD_ASSETS', chainId: 1301, rpcUrl: 'https://sepolia.unichain.org',
  genesisHash: hash('1'), serverId: hash('2'), deploymentId: hash('3'), registry: address('1'), market: address('2'), city: address('3'),
  codeHashes: { registry: keccak256(code), market: keccak256(code), city: keccak256(code) }, confirmations: 2,
  maxPriceBaseUnits: '1000000000000000000', maxGas: '500000', maxNativeCostWei: '1000000000000000' }
const policy = buildPrivyWorldAssetPolicies(manifest)
assert.equal(policy.player.rules.length, 6)
for (const rule of policy.player.rules) {
  assert.equal(rule.method, 'eth_signTransaction')
  assert(rule.conditions.some(value => value.field === 'chain_id' && value.value === '1301'))
  assert(rule.conditions.some(value => value.field === 'value' && value.value === '0'))
  const decoders = rule.conditions.filter(value => value.field_source === 'ethereum_calldata')
  assert(decoders.length); assert(decoders.every(value => value.abi.length === 1 && ['approve', 'requestRedemption', 'list', 'buy', 'cancel'].includes(value.abi[0].name)))
}
assert(!JSON.stringify(policy).includes('setApprovalForAll')); assert(!JSON.stringify(policy).includes('transferFrom'))
assert.throws(() => buildPrivyWorldAssetPolicies({ ...manifest, chainId: 1 }))
console.log('PASS pinned1301 zero-value managed policies permit only capped exact selectors, never generic transfers, blanket approvals or raw/message signatures')

let head = 10n, changed = false, stale = false, badCode = false
const client = { async getChainId() { return 1301 }, async getCode() { return badCode ? '0x6001' : code }, async getBlockNumber() { return head },
  async getBlock({ blockNumber }) { return { number: blockNumber, hash: blockNumber === 0n ? manifest.genesisHash : changed ? hash('b') : hash('a'), timestamp: BigInt(Math.floor(Date.now() / 1000) - (stale ? 100 : 0)) } },
  async readContract({ functionName }) { return functionName === 'registry' ? manifest.registry : functionName === 'city' ? manifest.city : functionName === 'symbol' ? 'CITY' : 18 } }
const reader = createCanonicalReader({ client, manifest: validateWorldAssetManifest(manifest) })
const block = await reader.snapshot(); assert.equal(block.blockNumber, 9n); assert.equal(block.confirmations, 2)
changed = true; await assert.rejects(reader.snapshot(block), /CANONICAL_REORG/); changed = false
stale = true; await assert.rejects(reader.snapshot(), /RPC_STALE/); stale = false
badCode = true; await assert.rejects(reader.verify(), /CODE_CHANGED/)
console.log('PASS canonical reads use head-minus-one and refuse stale RPC, changed deployment code and reorganized prior anchors')

let held = false, released = 0, poolQueries = 0, clientQueries = 0
const connection = { async query(sql) { clientQueries++; if (sql.includes('SELECT body')) return { rows: [{ body: { checked: true } }] }; return { rows: [] } }, release() { held = false; released++ } }
const pool = { async query() { poolQueries++; assert(!held, 'Store queries must not wait for another pool connection while holding its advisory lock'); return { rows: [] } }, async connect() { assert(!held); held = true; return connection } }
const store = await createWorldAssetStore(pool)
await store.lock('fixture-deployment', 'outer', async () => {
  assert.deepEqual(await store.get('fixture-deployment', 'row'), { checked: true })
  await store.put('fixture-deployment', 'row', { x: 1 })
  await store.lock('fixture-deployment', 'nested', async () => { await store.list('fixture-deployment', 'row') })
})
assert.equal(poolQueries, 1); assert.equal(released, 1); assert(clientQueries >= 7)
console.log('PASS locked/nested durable store operations share their held PostgreSQL client without exhausting the pool')

badCode = false
const principalId = '11111111-1111-4111-8111-111111111111', mcId = '22222222-2222-4222-8222-222222222222', botId = '33333333-3333-4333-8333-333333333333'
const rows = new Map(); let mismatchCount = false, observedRequest
const service = await createWorldAssets({ manifest, client,
  store: { async get(_, key) { return rows.get(key) }, async put(_, key, value) { rows.set(key, structuredClone(value)) }, async lock(_, __, work) { return work() } },
  wallets: { prepare() {}, broadcast() {}, reconcile() {} }, registrar: { address: address('4'), prepare() {}, broadcast() {}, reconcile() {} },
  resolveIdentity: async () => ({ principalId, minecraftPlayerId: mcId, privySubject: 'did:privy:resource-fixture', walletAddress: address('5'), agentInventories: [{ agentId: 'FixtureAgent', sourceId: botId }] }),
  resolveWalletOwner: async () => null, authorize: async () => false,
  native: async (_, request) => { observedRequest = request; return { previewId: request.operationId, sourceId: botId, worldName: 'agentcity_play', count: mismatchCount ? 1 : request.count,
    item: 'minecraft:stick', fingerprint: 'd'.repeat(64), descriptor: { material: 'minecraft:stick', amount: request.count }, expiresAtMs: Date.now() + 300000 } }
})
const request = { principalId, kind: 'item', sourceKind: 'agent_inventory', agentId: 'FixtureAgent', selection: 8 }
const lot = await service.previewMint({ ...request, operationId: 'two-stick-resource-lot', count: 2 })
assert.equal(observedRequest.count, 2); assert.equal(lot.terms.nativePreview.count, 2); assert.equal(lot.terms.nativePreview.descriptor.amount, 2)
await assert.rejects(service.previewMint({ ...request, operationId: 'oversized-lot', count: 65 }), /LOT_COUNT_REQUIRED/)
mismatchCount = true
await assert.rejects(service.previewMint({ ...request, operationId: 'wrong-observed-lot', count: 2 }), /NATIVE_PREVIEW_BINDING/)
console.log('PASS resource NFT previews bind requested native lot count and descriptor; oversized or differently observed portions refuse before custody/signing')
