import { getAddress, keccak256, zeroAddress } from 'viem'
import { createCanonicalReader, validateWorldAssetManifest, hex32 } from '../world-assets/canonical.mjs'

const addresses = ['registry', 'market', 'city', 'usdc', 'gem', 'bank', 'router', 'hook', 'stateRegistry', 'workEscrow', 'poolManager', 'quoter']
const fail = code => { throw Error(code) }

export function validateBankManifest(input, { allowLocalFixture = false } = {}) {
  const manifest = structuredClone(input)
  const local = allowLocalFixture && manifest?.environment === 'LOCAL_TEST_FIXTURE' && manifest.chainId === 31337
    && /^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(manifest.rpcUrl || '')
  const testnet = manifest?.environment === 'UNICHAIN_SEPOLIA_BANK' && manifest.chainId === 1301
    && manifest.rpcUrl === 'https://sepolia.unichain.org'
  if (manifest?.schema !== 'agentcity.bank.v1' || !local && !testnet || manifest.confirmations !== 2
    || !['genesisHash', 'deploymentId', 'serverId'].every(key => hex32(manifest[key]))) fail('BANK_PINNED_TESTNET_MANIFEST_REQUIRED')
  for (const key of addresses) {
    try { manifest[key] = getAddress(manifest[key]).toLowerCase() } catch { fail('BANK_DEPLOYMENT_ADDRESS_REQUIRED') }
    if (manifest[key] === zeroAddress || !hex32(manifest.codeHashes?.[key])) fail('BANK_DEPLOYMENT_CODE_HASH_REQUIRED')
  }
  if (new Set(addresses.map(key => manifest[key])).size !== addresses.length) fail('BANK_DISTINCT_DEPLOYMENTS_REQUIRED')
  for (const key of ['maxNativeCostWei', 'maxCityAmountBaseUnits', 'maxUsdcAmountBaseUnits']) {
    if (!/^[1-9][0-9]*$/.test(manifest[key] || '')) fail('BANK_EXPLICIT_SPENDING_LIMIT_REQUIRED')
  }
  if (!Number.isSafeInteger(Number(manifest.maxGas)) || Number(manifest.maxGas) < 21000 || Number(manifest.maxGas) > 3000000
    || BigInt(manifest.maxNativeCostWei) > 8000000000000000n || BigInt(manifest.maxCityAmountBaseUnits) > 100n * 10n ** 18n
    || BigInt(manifest.maxUsdcAmountBaseUnits) > 30n * 10n ** 6n) fail('BANK_TESTNET_LIMIT_EXCEEDED')
  for (const key of ['administrator', 'issuer', 'lender', 'inspector', 'registrar', 'publisher']) {
    try { manifest.roles[key] = getAddress(manifest.roles[key]).toLowerCase() } catch { fail('BANK_DISTINCT_ROLES_REQUIRED') }
  }
  if (new Set(Object.values(manifest.roles)).size !== Object.values(manifest.roles).length) fail('BANK_DISTINCT_ROLES_REQUIRED')
  const assets = validateWorldAssetManifest(manifest.worldAssets, { allowLocalFixture })
  if (['registry', 'market', 'city', 'chainId', 'rpcUrl', 'genesisHash', 'serverId'].some(key => assets[key] !== manifest[key])) fail('BANK_NATIVE_MARKET_BINDING_CHANGED')
  manifest.worldAssets = assets
  for (const [name, token, fee, hook] of [['cityUsdc', 'city', 0x800000, manifest.hook], ['gemUsdc', 'gem', 3000, zeroAddress]]) {
    const key = manifest.pools?.[name]
    if (!key || Number(key.fee) !== fee || Number(key.tickSpacing) !== 60
      || String(key.hooks).toLowerCase() !== hook
      || [key.currency0, key.currency1].map(value => String(value).toLowerCase()).sort().join(':') !== [manifest[token], manifest.usdc].sort().join(':')
      || String(key.currency0).toLowerCase() >= String(key.currency1).toLowerCase()) fail('BANK_POOL_BINDING_REQUIRED')
  }
  return manifest
}

export function createBankReader({ client, manifest, abis, now = Date.now }) {
  const base = createCanonicalReader({ client, manifest: manifest.worldAssets, now })
  async function verify() {
    await base.verify()
    await Promise.all(addresses.filter(key => !['registry', 'market', 'city'].includes(key)).map(async key => {
      const code = await client.getCode({ address: manifest[key] })
      if (!code || code === '0x' || keccak256(code).toLowerCase() !== manifest.codeHashes[key].toLowerCase()) fail('BANK_DEPLOYMENT_CODE_CHANGED')
    }))
    const bindings = [
      ['bank', 'registry', manifest.registry], ['bank', 'usdc', manifest.usdc], ['bank', 'lender', manifest.roles.lender],
      ['router', 'registry', manifest.registry], ['router', 'market', manifest.market], ['router', 'city', manifest.city],
      ['router', 'usdc', manifest.usdc], ['router', 'gem', manifest.gem], ['router', 'hook', manifest.hook],
      ['workEscrow', 'city', manifest.city], ['workEscrow', 'inspector', manifest.roles.inspector]
    ]
    await Promise.all(bindings.map(async ([target, functionName, expected]) => {
      const value = await client.readContract({ address: manifest[target], abi: abis[target], functionName })
      if (String(value).toLowerCase() !== expected) fail('BANK_CONTRACT_BINDING_CHANGED')
    }))
    const decimals = await Promise.all(['city', 'gem', 'usdc'].map(key => client.readContract({ address: manifest[key], abi: abis[key], functionName: 'decimals' })))
    if (decimals.map(Number).join(':') !== '18:18:6') fail('BANK_TOKEN_DECIMALS_CHANGED')
  }
  return { ...base, verify }
}
