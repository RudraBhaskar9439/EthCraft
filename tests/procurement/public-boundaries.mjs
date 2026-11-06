import assert from 'node:assert/strict'
import { PublicTestnetEvm, TESTNET_NATIVE_CAP } from '../../backend/src/chain/public-testnet.mjs'

const signer = '0x1111111111111111111111111111111111111111'
const settings = { store: {}, chainId: 1301, rpcUrl: 'https://sepolia.unichain.org', genesisHash: '0x' + '11'.repeat(32), environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: [signer] }
assert.throws(() => new PublicTestnetEvm({ ...settings, chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com' }), /public_testnet_configuration_required/)
assert.throws(() => new PublicTestnetEvm({ ...settings, environment: 'production' }), /public_testnet_configuration_required/)
const evm = new PublicTestnetEvm(settings)
await assert.rejects(evm.prepare('unused', { address: '0x2222222222222222222222222222222222222222' }, signer, '0x'), /testnet_signer_or_value_denied/)
const emptyLedger = { query: async () => ({ rows: [] }) }
await evm.validateRequest(emptyLedger, { gas: 21000n, maxFeePerGas: 1n, value: 0n })
await assert.rejects(evm.validateRequest(emptyLedger, { gas: 21000n, maxFeePerGas: 1n, value: TESTNET_NATIVE_CAP }), /testnet_native_budget_exhausted/)
console.log('PASS 4/4: explicit testnet scope, approved signer, bounded fee and native transfer authorization; no network calls')
