import assert from 'node:assert/strict'
import { inventoryGameSeedTerms, validateInventoryGameSeedTransaction } from '../../scripts/inventory_game_seed_merchant.mjs'

const original = { chainId: 1301, rpcUrl: 'https://sepolia.unichain.org', genesisHash: '0x' + 'a'.repeat(64),
  journalSchema: 'bank_deployment_1301_9e0144797c4a', maximumNativeBudgetWei: '4000000000000000', serverId: '0x' + 'b'.repeat(64), deploymentId: '0x' + 'c'.repeat(64) }
const manifest = { ...original, mode: 'marketplace', environment: 'UNICHAIN_SEPOLIA_BANK', deploymentId: '0x' + 'd'.repeat(64),
  historicalDeployment: { deploymentId: original.deploymentId, manifestSha256: 'e'.repeat(64), manifestUnchanged: true } }
const input = { manifest, original, originalManifestSha256: 'e'.repeat(64), source: '0x' + '1'.repeat(40), developerAddress: '0x' + '1'.repeat(40), recipient: '0x' + '2'.repeat(40) }
const terms = inventoryGameSeedTerms(input)
assert.deepEqual(inventoryGameSeedTerms(input), terms)
assert.equal(terms.valueWei, '1200000000000000'); assert.equal(terms.data, '0x')
assert.equal(terms.maximumNativeBudgetWei, original.maximumNativeBudgetWei); assert.equal(terms.journalSchema, original.journalSchema)
assert.throws(() => inventoryGameSeedTerms({ ...input, source: '0x' + '3'.repeat(40) }), /SOURCE_OR_RECIPIENT_REQUIRED/)
assert.throws(() => inventoryGameSeedTerms({ ...input, source: '0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f', developerAddress: '0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f' }), /SOURCE_OR_RECIPIENT_REQUIRED/)
assert.throws(() => inventoryGameSeedTerms({ ...input, manifest: { ...manifest, maximumNativeBudgetWei: '8000000000000000' } }), /ORIGINAL_JOURNAL_REQUIRED/)
assert.throws(() => inventoryGameSeedTerms({ ...input, originalManifestSha256: 'f'.repeat(64) }), /ORIGINAL_JOURNAL_REQUIRED/)
const transaction = { chainId: 1301, from: terms.source, to: terms.recipient, data: '0x', value: 1200000000000000n, gas: 21000n, maxFeePerGas: 1600000n }
validateInventoryGameSeedTransaction(terms, transaction)
for (const changed of [{ to: terms.source }, { value: transaction.value + 1n }, { data: '0x01' }, { gas: 30001n }, { maxFeePerGas: 2000000000n }]) {
  assert.throws(() => validateInventoryGameSeedTransaction(terms, { ...transaction, ...changed }), /EXACT_TRANSACTION_REQUIRED/)
}
console.log('PASS fixed merchant ops seed binds developer, original manifest/journal/budget, stable purpose and exact value/calldata with gas/fee caps; no keys opened, RPC, signing or transfer')
