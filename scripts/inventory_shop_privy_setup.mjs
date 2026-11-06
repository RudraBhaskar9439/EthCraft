import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import pg from '../backend/node_modules/pg/lib/index.js'
import { PrivyClient } from '../backend/node_modules/@privy-io/node/index.mjs'
import checkpoints from '../backend/src/bot/checkpoint-store.cjs'
import { buildPrivyWorldAssetPolicies } from '../backend/src/world-assets/managed-policy.mjs'
import { createPrivyManagedProvider, loadPrivySettings, privyPolicyFingerprint } from '../backend/src/playable/testnet-wallets.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const oneCity = '1000000000000000000'
const nativeBudget = '8000000000000000'
const fail = code => { throw Error(code) }

export function buildInventoryShopPrivyPolicy(manifest) {
  const built = buildPrivyWorldAssetPolicies({ ...manifest, maxPriceBaseUnits: oneCity })
  const targets = { approve: manifest.city.toLowerCase(), buy: manifest.market.toLowerCase(), requestRedemption: manifest.registry.toLowerCase() }
  const rules = built.player.rules.filter(rule => {
    const method = rule.conditions.find(condition => condition.field_source === 'ethereum_calldata')?.abi?.[0]?.name
    const destination = rule.conditions.find(condition => condition.field_source === 'ethereum_transaction' && condition.field === 'to')?.value
    return Object.hasOwn(targets, method) && destination === targets[method]
  })
  if (rules.length !== 3) fail('INVENTORY_SHOP_PRIVY_THREE_BUYER_RULES_REQUIRED')
  return { player: { ...built.player, rules }, allowedTargets: built.allowedTargets }
}

async function managedWalletCount(pool) {
  const present = (await pool.query("SELECT to_regclass('ac_playable_testnet_wallets') IS NOT NULL AS present")).rows[0].present
  return present ? Number((await pool.query("SELECT count(*) AS count FROM ac_playable_testnet_wallets WHERE provider_type='privy'")).rows[0].count) : 0
}

async function main() {
  const apply = process.argv.length === 3 && process.argv[2] === '--apply'
  if (process.argv.length !== 2 && !apply) fail('INVENTORY_SHOP_PRIVY_USE_PREFLIGHT_OR_APPLY')
  const settingsFile = join(root, '.local/playable-testnet/wallet-settings.json')
  const originalSettings = await readFile(settingsFile, 'utf8')
  const { settings, credentials } = await loadPrivySettings(root, { requireProvider: false })
  if (JSON.stringify(JSON.parse(originalSettings)) !== JSON.stringify(settings)) fail('INVENTORY_SHOP_PRIVY_SETTINGS_CHANGED')
  const discord = JSON.parse(await readFile(join(root, '.local/discord/settings.json'), 'utf8'))
  if (discord.identityOnly !== true) fail('INVENTORY_SHOP_PRIVY_IDENTITY_ONLY_REQUIRED')
  const deployment = JSON.parse(await readFile(join(root, '.local/marketplace/public-deployment.json'), 'utf8'))
  const manifest = deployment.worldAssets
  if (deployment.mode !== 'marketplace' || deployment.chainId !== 1301 || !manifest ||
      ['city', 'market', 'registry', 'serverId', 'genesisHash', 'rpcUrl'].some(key => manifest[key] !== deployment[key]) ||
      ['city', 'market', 'registry'].some(key => manifest.codeHashes?.[key] !== deployment.codeHashes?.[key])) {
    fail('INVENTORY_SHOP_PRIVY_CURRENT_MARKETPLACE_REQUIRED')
  }
  const { player, allowedTargets } = buildInventoryShopPrivyPolicy(manifest)
  const fingerprint = privyPolicyFingerprint(player)
  if (settings.policyId && settings.policySha256 !== fingerprint || Object.keys(settings.rolePolicies || {}).length) {
    fail('INVENTORY_SHOP_PRIVY_POLICY_MIGRATION_REQUIRES_REVIEW')
  }
  const providerSettings = { ...settings, ...credentials, policyId: settings.policyId || 'unapplied-inventory-policy',
    policySha256: fingerprint, allowedTargets }
  // Validate distinct owner/delegate keys without loading the offline administrator key.
  createPrivyManagedProvider(providerSettings)
  const client = new PrivyClient({ appId: settings.appId, appSecret: credentials.appSecret, maxRetries: 0, timeout: 15000 })
  for (const [id, publicKey] of [[settings.ownerQuorumId, credentials.ownerPublicKey], [settings.delegateQuorumId, credentials.delegatePublicKey]]) {
    const quorum = await client.keyQuorums().get(id)
    if (quorum.id !== id || quorum.authorization_threshold !== 1 || quorum.authorization_keys?.length !== 1 ||
        quorum.authorization_keys[0].public_key !== publicKey || (quorum.user_ids?.length || 0) || (quorum.key_quorum_ids?.length || 0)) {
      fail('INVENTORY_SHOP_PRIVY_AUTHORITY_CHANGED')
    }
  }
  const environment = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  const pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 1 })
  const release = apply ? await checkpoints.acquireLocalLease('agentcity-inventory-shop-privy-setup') : null
  try {
    const walletCount = await managedWalletCount(pool)
    if (walletCount && !settings.policyId) fail('INVENTORY_SHOP_PRIVY_EXISTING_WALLETS_REQUIRE_REVIEW')
    const name = 'AgentCity inventory buyer ' + fingerprint.slice(0, 12)
    const verifyPolicy = policy => {
      if (!policy?.id || policy.owner_id !== settings.ownerQuorumId || policy.chain_type !== 'ethereum' || privyPolicyFingerprint(policy) !== fingerprint) {
        fail('INVENTORY_SHOP_PRIVY_POLICY_BINDING_CHANGED')
      }
      return policy
    }
    let policy
    if (settings.policyId) policy = verifyPolicy(await client.policies().get(settings.policyId))
    else for await (const candidate of client.policies().list({ limit: 100 })) {
      if (candidate.name !== name) continue
      if (policy) fail('INVENTORY_SHOP_PRIVY_DUPLICATE_POLICY')
      policy = verifyPolicy(await client.policies().get(candidate.id))
    }
    if (apply && !policy) {
      if (await managedWalletCount(pool)) fail('INVENTORY_SHOP_PRIVY_EXISTING_WALLETS_REQUIRE_REVIEW')
      const idempotencyKey = 'ac-inventory-buyer-' + createHash('sha256').update(settings.appId + ':' + settings.ownerQuorumId + ':' + fingerprint).digest('hex').slice(0, 48)
      const created = await client.policies().create({ ...player, name, owner_id: settings.ownerQuorumId, idempotency_key: idempotencyKey })
      policy = verifyPolicy(await client.policies().get(created.id))
    }
    if (policy) {
      const provider = createPrivyManagedProvider({ ...providerSettings, policyId: policy.id, client })
      await provider.validateConfiguration()
    }
    let changed = false
    if (apply) {
      const next = { ...settings, policyId: policy.id, policySha256: fingerprint, allowedTargets,
        allowBroadcast: true, maxNativeBudgetWei: nativeBudget }
      changed = JSON.stringify(next) !== JSON.stringify(settings)
      if (changed) {
        if (await managedWalletCount(pool)) fail('INVENTORY_SHOP_PRIVY_EXISTING_WALLETS_REQUIRE_REVIEW')
        if (await readFile(settingsFile, 'utf8') !== originalSettings) fail('INVENTORY_SHOP_PRIVY_SETTINGS_CHANGED')
        await checkpoints.writeCheckpoint(settingsFile, next)
      }
    }
    console.log(JSON.stringify({ status: apply ? 'pass' : 'ready', applied: apply, settingsChanged: changed,
      policyPresent: Boolean(policy), policyVerifiedByGet: Boolean(policy), policySha256: fingerprint,
      policyId: policy?.id || null, methods: ['approve CITY to current market', 'buy', 'requestRedemption'],
      maximumPurchaseCity: '1', maximumCumulativeTestEth: '0.008', allowedTargets,
      nativeRouteActivated: false, identityOnlyPreserved: true, walletsCreated: 0, signatures: 0, publicTransactions: 0,
      scope: 'Buyer-only Privy policy configuration. The separately gated native shop route is not enabled by this script.' }))
  } finally { await pool.end(); await release?.() }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ status: 'blocked', code: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'INVENTORY_SHOP_PRIVY_SETUP_UNAVAILABLE',
    httpStatus: Number.isInteger(error.status) ? error.status : null, walletsCreated: 0, signatures: 0, publicTransactions: 0 }))
  process.exitCode = 1
})
