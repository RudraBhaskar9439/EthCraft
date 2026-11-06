import { mkdir, readFile, writeFile, open, rename, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureTestnetKeystore, loadPrivySettings, buildPrivyMarketPolicies, privyPolicyFingerprint, createTestnetWallets, updatePrivyTreasuryPolicy, verifyProvisioningIdentity } from '../backend/src/playable/testnet-wallets.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = new URL('.local/playable-testnet/', new URL('../', import.meta.url))
const args = process.argv.slice(2)
async function privateAdmin(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('PRIVATE_ADMIN_FILE_REQUIRED')
  return JSON.parse(await readFile(path, 'utf8'))
}
async function replacePrivate(path, value) {
  const temporary = path + '.setup.tmp'
  const descriptor = await open(temporary, 'wx', 0o600)
  try { await descriptor.writeFile(JSON.stringify(value, null, 2) + '\n'); await descriptor.sync() } finally { await descriptor.close() }
  await rename(temporary, path)
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}
if (args.length === 3 && args[0] === '--provision-player' && args[1] === '--player') {
  const { settings, provider } = await loadPrivySettings(root)
  const { default: pg } = await import('../backend/node_modules/pg/lib/index.js')
  const database = JSON.parse(await readFile(new URL('.local/backend/environment.json', new URL('../', import.meta.url)), 'utf8'))
  const pool = new pg.Pool({ connectionString: database.databaseUrl, max: 2 })
  try {
    const active = JSON.parse(await readFile(new URL('.local/playable-world/active.json', new URL('../', import.meta.url)), 'utf8'))
    const personalAgents = JSON.parse(await readFile(active.runtime + '/personal-agents.json', 'utf8'))
    const enrollment = JSON.parse(await readFile(settings.enrollmentFile, 'utf8'))
    const identity = await verifyProvisioningIdentity({ pool, playerName: args[2], appId: settings.appId, enrollment, personalAgents })
    const manifest = JSON.parse(await readFile(new URL('market.json', directory), 'utf8'))
    await provider.validateConfiguration()
    const wallets = await createTestnetWallets({ pool, rootDirectory: root, environment: manifest.environment,
      chainId: manifest.chainId, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash,
      provider, allowedTargets: settings.allowedTargets, allowBroadcast: false })
    const wallet = await wallets.getOrCreate(identity.playerId, { subject: identity.subject })
    console.log(JSON.stringify({ status: 'pass', scope: 'Operator provisioning after actual human Privy authentication and immutable enrolled game identity binding; no gameplay or spending authorization',
      playerName: identity.playerName, address: wallet.address, chainId: wallet.chainId, provider: 'privy',
      sessionExpiresAt: identity.expiresAt, offlineOwnerVerified: true, restrictedDelegateVerified: true,
      gameOnlineRequirementBypassedForAccountProvisioningOnly: true, publicTransactions: 0 }))
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', code: 'PRIVY_PLAYER_PROVISIONING_UNAVAILABLE',
      reason: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : null,
      httpStatus: Number.isInteger(error.status) ? error.status : null, publicTransactions: 0 }))
    process.exitCode = 1
  } finally { await pool.end() }
} else if (args.length === 1 && args[0] === '--verify-provider') {
  try {
    const { provider, settings } = await loadPrivySettings(root)
    const result = await provider.validateConfiguration()
    console.log(JSON.stringify({ status: 'pass', scope: 'Actual Privy GET verification of offline owner quorum, distinct scoped delegate quorum, and exact player policy ownership and restrictions',
      ...result, policySha256: settings.policySha256, publicTransactions: 0 }))
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', code: 'PRIVY_CONFIGURATION_VERIFICATION_FAILED',
      reason: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : null,
      httpStatus: Number.isInteger(error.status) ? error.status : null, publicTransactions: 0 }))
    process.exitCode = 1
  }
} else if (args.length === 1 && args[0] === '--separate-owner') {
  const { settings, credentials } = await loadPrivySettings(root, { requireProvider: false })
  const { PrivyClient, generateP256KeyPair } = await import('../backend/node_modules/@privy-io/node/index.mjs')
  const sdk = new PrivyClient({ appId: settings.appId, appSecret: credentials.appSecret, maxRetries: 0, timeout: 15000 })
  try {
  const adminPath = settings.adminCredentialsFile || settings.credentialsFile + '.admin.json'
  let admin
  try { admin = await privateAdmin(adminPath) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (!credentials.authorizationPrivateKey || !credentials.ownerPublicKey) throw Error('EXISTING_OWNER_AUTHORIZATION_REQUIRED')
    admin = { authorizationPrivateKey: credentials.authorizationPrivateKey, ownerPublicKey: credentials.ownerPublicKey }
    await replacePrivate(adminPath, admin)
  }
  if (admin.ownerPublicKey !== credentials.ownerPublicKey ||
    (credentials.authorizationPrivateKey && credentials.authorizationPrivateKey !== admin.authorizationPrivateKey)) throw Error('OWNER_KEY_BINDING_CHANGED')
  if (!admin.pendingDelegate) {
    admin.pendingDelegate = credentials.delegateAuthorizationPrivateKey ? { privateKey: credentials.delegateAuthorizationPrivateKey, publicKey: credentials.delegatePublicKey } : await generateP256KeyPair()
    await replacePrivate(adminPath, admin)
  }
  const ensureQuorum = async (publicKey, role) => {
    const matches = []
    for await (const quorum of sdk.keyQuorums().list({ limit: 100 })) {
      if (quorum.authorization_keys?.some(key => key.public_key === publicKey)) {
        if (quorum.authorization_keys.length !== 1 || quorum.authorization_threshold !== 1 ||
          (quorum.user_ids?.length ?? 0) || (quorum.key_quorum_ids?.length ?? 0)) throw Error('AUTHORIZATION_QUORUM_REQUIRES_REVIEW')
        matches.push(quorum)
      }
    }
    if (matches.length > 1) throw Error('DUPLICATE_AUTHORIZATION_QUORUM_REQUIRES_REVIEW')
    const quorum = matches[0] || await sdk.keyQuorums().create({ display_name: 'AgentCity ' + role + ' 1301', public_keys: [publicKey], authorization_threshold: 1 })
    if (quorum.authorization_keys?.length !== 1 || quorum.authorization_keys[0].public_key !== publicKey || quorum.authorization_threshold !== 1) throw Error('CREATED_AUTHORIZATION_QUORUM_CHANGED')
    return quorum.id
  }
  admin.ownerQuorumId = await ensureQuorum(admin.ownerPublicKey, 'offline owner')
  await replacePrivate(adminPath, admin)
  admin.delegateQuorumId = await ensureQuorum(admin.pendingDelegate.publicKey, 'restricted runtime signer')
  await replacePrivate(adminPath, admin)
  if (admin.ownerQuorumId === admin.delegateQuorumId || admin.ownerPublicKey === admin.pendingDelegate.publicKey) throw Error('DISTINCT_OWNER_DELEGATE_REQUIRED')
  const runtime = { ...credentials, delegateAuthorizationPrivateKey: admin.pendingDelegate.privateKey, delegatePublicKey: admin.pendingDelegate.publicKey }
  delete runtime.authorizationPrivateKey
  await replacePrivate(settings.credentialsFile, runtime)
  await writeFile(new URL('wallet-settings.json', directory), JSON.stringify({ ...settings, adminCredentialsFile: adminPath,
    ownerQuorumId: admin.ownerQuorumId, delegateQuorumId: admin.delegateQuorumId, allowBroadcast: false }, null, 2) + '\n')
  await loadPrivySettings(root)
  console.log(JSON.stringify({ status: 'pass', scope: 'Actual Privy owner and delegate quorum configuration; offline owner private key excluded from runtime credentials',
    ownerQuorumId: admin.ownerQuorumId, delegateQuorumId: admin.delegateQuorumId, walletsCreated: 0, publicTransactions: 0,
    limitations: 'Local private file separation is not an OS security boundary from the same Unix user; isolate admin key offline or under a different operator identity before production deployment.' }))
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', code: 'PRIVY_AUTHORITY_SEPARATION_UNAVAILABLE',
      reason: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : null,
      httpStatus: Number.isInteger(error.status) ? error.status : null, publicTransactions: 0 }))
    process.exitCode = 1
  }
} else if (args.length === 1 && args[0] === '--authorize-privy') {
  const { settings, credentials } = await loadPrivySettings(root, { requireProvider: false })
  const { PrivyClient, generateP256KeyPair } = await import('../backend/node_modules/@privy-io/node/index.mjs')
  const sdk = new PrivyClient({ appId: settings.appId, appSecret: credentials.appSecret, maxRetries: 0, timeout: 15000 })
  try {
    await sdk.wallets().list({ limit: 1 })
    if (!credentials.delegateAuthorizationPrivateKey && (!credentials.authorizationPrivateKey || !credentials.ownerPublicKey)) {
      if (credentials.authorizationPrivateKey || credentials.ownerPublicKey) throw Error('PARTIAL_PRIVY_AUTHORIZATION_PAIR_REQUIRES_REVIEW')
      const pair = await generateP256KeyPair()
      const temporary = settings.credentialsFile + '.authorization.tmp'
      const descriptor = await open(temporary, 'wx', 0o600)
      try { await descriptor.writeFile(JSON.stringify({ ...credentials, authorizationPrivateKey: pair.privateKey, ownerPublicKey: pair.publicKey }, null, 2) + '\n'); await descriptor.sync() }
      finally { await descriptor.close() }
      await rename(temporary, settings.credentialsFile)
      const directory = await open(dirname(settings.credentialsFile), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    console.log(JSON.stringify({ status: 'pass', scope: 'Actual Privy API credential verification and SDK-generated private P-256 authorization pair',
      provider: 'privy', sdkVersion: '0.37.0', apiAuthenticationVerified: true, authorizationKeyStoredPrivately: true,
      playerWalletsCreated: 0, publicTransactions: 0, policySetupPending: !settings.policyId }))
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', provider: 'privy', code: 'PRIVY_AUTHORIZATION_SETUP_UNAVAILABLE',
      httpStatus: Number.isInteger(error.status) ? error.status : null, publicTransactions: 0 }))
    process.exitCode = 1
  }
} else if (['--configure-policy', '--update-treasury-policy'].includes(args[0]) && args.length <= 2) {
  const { settings, credentials } = await loadPrivySettings(root, { requireProvider: false })
  if (!credentials.ownerPublicKey) throw Error('RUN_AUTHORIZE_PRIVY_FIRST')
  const manifestPath = args[1] || fileURLToPath(new URL('.local/playable-testnet/market.json', new URL('../', import.meta.url)))
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    console.log(JSON.stringify({ status: 'blocked', code: 'PUBLIC_MARKET_DEPLOYMENT_REQUIRED', publicTransactions: 0 }))
    process.exit(1)
  }
  const { PrivyClient } = await import('../backend/node_modules/@privy-io/node/index.mjs')
  const { default: pg } = await import('../backend/node_modules/pg/lib/index.js')
  const database = JSON.parse(await readFile(new URL('.local/backend/environment.json', new URL('../', import.meta.url)), 'utf8'))
  const pool = new pg.Pool({ connectionString: database.databaseUrl, max: 2 })
  try {
    let recipients = []
    const exists = (await pool.query("SELECT to_regclass('ac_playable_testnet_wallets') AS name")).rows[0].name
    if (exists) recipients = (await pool.query(`SELECT address FROM ac_playable_testnet_wallets
      WHERE environment='UNICHAIN_SEPOLIA_PLAYABLE' AND provider_type='privy' AND auth_subject_hash IS NOT NULL ORDER BY address`)).rows.map(row => row.address)
    const templates = buildPrivyMarketPolicies(manifest, recipients)
    const sdk = new PrivyClient({ appId: settings.appId, appSecret: credentials.appSecret, maxRetries: 0, timeout: 15000 })
    const next = { ...settings, allowedTargets: templates.allowedTargets, allowBroadcast: false }
    const ensurePolicy = async (role, template) => {
      const fingerprint = privyPolicyFingerprint(template)
      const name = 'AgentCity ' + role + ' 1301 ' + fingerprint.slice(0, 16)
      const matches = []
      for await (const policy of sdk.policies().list({ limit: 100 })) if (policy.name === name) {
        const full = await sdk.policies().get(policy.id)
        if (privyPolicyFingerprint(full) !== fingerprint) {
          await writeFile(new URL('policy-diagnostic.json', directory), JSON.stringify({ expected: template, actual: { chain_type: full.chain_type, version: full.version, rules: full.rules } }, null, 2))
          throw Error('EXISTING_PROVIDER_POLICY_CONFLICT')
        }
        matches.push(full)
      }
      if (matches.length > 1) throw Error('DUPLICATE_PROVIDER_POLICY_REQUIRES_REVIEW')
      const policy = matches[0] || await sdk.policies().create({ ...template, name,
        owner: { public_key: credentials.ownerPublicKey },
        idempotency_key: 'ac-' + createHash('sha256').update(settings.appId + ':' + role + ':' + fingerprint).digest('hex').slice(0, 56) })
      if (privyPolicyFingerprint(policy) !== fingerprint) throw Error('CREATED_PROVIDER_POLICY_CHANGED')
      return { policyId: policy.id, policySha256: fingerprint }
    }
    Object.assign(next, await ensurePolicy('player', templates.player))
    next.rolePolicies = { ...(next.rolePolicies || {}) }
    if (templates.treasury) next.rolePolicies.treasury = await ensurePolicy('treasury', templates.treasury)
    else delete next.rolePolicies.treasury
    const previousTreasury = settings.rolePolicies?.treasury
    const treasuryExists = exists && (await pool.query('SELECT 1 FROM ac_playable_testnet_wallets WHERE wallet_id=$1', ['UNICHAIN_SEPOLIA_PLAYABLE:role:treasury'])).rowCount > 0
    if (treasuryExists && previousTreasury && next.rolePolicies.treasury && previousTreasury.policyId !== next.rolePolicies.treasury.policyId) {
      if (args[0] !== '--update-treasury-policy') throw Error('EXPLICIT_TREASURY_POLICY_UPDATE_REQUIRED')
      const admin = await privateAdmin(settings.adminCredentialsFile)
      await updatePrivyTreasuryPolicy({ pool, client: sdk, authorizationPrivateKey: admin.authorizationPrivateKey,
        delegateQuorumId: settings.delegateQuorumId, ownerQuorumId: settings.ownerQuorumId,
        previous: previousTreasury, next: next.rolePolicies.treasury, recipients })
    }
    await writeFile(new URL('wallet-settings.json', directory), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    const configured = await loadPrivySettings(root)
    let treasuryAddress = null
    if (templates.treasury) {
      const wallets = await createTestnetWallets({ pool, rootDirectory: root, environment: manifest.environment,
        chainId: manifest.chainId, rpcUrl: manifest.rpcUrl, genesisHash: manifest.genesisHash,
        provider: configured.provider, allowedTargets: templates.allowedTargets, allowBroadcast: false })
      treasuryAddress = (await wallets.getRoleWallet('treasury')).address
    }
    console.log(JSON.stringify({ status: 'pass', scope: 'Actual Privy enclave-policy configuration from the dedicated public market manifest',
      playerPolicyConfigured: true, treasuryPolicyConfigured: Boolean(templates.treasury),
      treasuryRecipientCount: recipients.length, treasuryAddress, playerWalletsCreated: 0, publicTransactions: 0,
      treasuryPendingReason: templates.treasury ? null : 'An enrolled player must authenticate and create a managed wallet before a recipient-restricted treasury can be configured.' }))
  } catch (error) {
    const providerReason = typeof error.error === 'string' ? error.error : typeof error.error?.message === 'string' ? error.error.message :
      typeof error.error?.error === 'string' ? error.error.error : null
    const safeProviderReason = providerReason && [credentials.appSecret, credentials.authorizationPrivateKey, credentials.ownerPublicKey]
      .filter(Boolean).reduce((message, secret) => message.split(secret).join('[redacted]'), providerReason).slice(0, 1200)
    console.log(JSON.stringify({ status: 'blocked', code: 'PRIVY_POLICY_SETUP_UNAVAILABLE',
      reason: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : null,
      providerReason: safeProviderReason,
      httpStatus: Number.isInteger(error.status) ? error.status : null, publicTransactions: 0 }))
    process.exitCode = 1
  } finally { await pool.end() }
} else {
if (args.length) throw Error('UNSUPPORTED_TESTNET_SETUP_ARGUMENT')
await mkdir(directory, { recursive: true })
const path = new URL('account-settings.json', directory)
let existing
try { existing = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (existing && (existing.environment !== 'UNICHAIN_SEPOLIA_PLAYABLE' || existing.chainId !== 1301)) throw Error('NEW_PLAYABLE_TESTNET_ROLE_CONTEXT_REQUIRED')
const wallet = await ensureTestnetKeystore({ rootDirectory: root, privateRoot: existing?.privateRoot, keyId: 'role-developer' })
if (existing && existing.address !== wallet.address) throw Error('PLAYABLE_DEVELOPER_KEY_CHANGED')
await writeFile(path, JSON.stringify({ environment: 'UNICHAIN_SEPOLIA_PLAYABLE', chainId: 1301,
  rpcUrl: 'https://sepolia.unichain.org', ...wallet }, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ scope: 'NEW disposable server-managed Unichain Sepolia developer signer; encrypted keys stay in private WSL storage',
  chainId: 1301, address: wallet.address, fundingRequired: true, publicTransactions: 0,
  faucetInstructions: 'Use an official listed free Unichain Sepolia ETH faucet; never send mainnet funds.',
  officialFaucetDocumentation: 'https://developers.uniswap.org/docs/unichain/tools/faucets' }))
}
