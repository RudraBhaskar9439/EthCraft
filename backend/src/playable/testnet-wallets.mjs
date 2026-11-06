import { randomBytes, createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseTransaction, recoverTransactionAddress, keccak256, toHex } from 'viem'
import { unichainSepolia, foundry } from 'viem/chains'
import { openDevelopmentKeystore } from '../chain/development-wallets.mjs'
import { DurableEvm } from '../chain/durable-evm.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const ADDRESS = /^0x[a-f0-9]{40}$/i
const ROLES = new Set(['developer', 'treasury', 'liquidity'])
const PUBLIC_ENV = 'UNICHAIN_SEPOLIA_PLAYABLE'
const LOCAL_ENV = 'LOCAL_TEST_FIXTURE'
const nativeCap = 8000000000000000n
const publicWallet = (id, address, chainId) => ({ walletId: id, address, chainId, custody: 'server_managed_testnet', realValueSupported: false })
const normalized = value => JSON.parse(JSON.stringify(value, (_, field) => typeof field === 'bigint' ? field.toString() : field))

async function privatePath(path, directory = false) {
  if (typeof process.getuid !== 'function') throw Error('TESTNET_CUSTODY_REQUIRES_UNIX_PRIVATE_FILES')
  const info = await lstat(path)
  if (info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) ||
      (directory ? !info.isDirectory() : !info.isFile())) throw Error('TESTNET_PRIVATE_FILE_PERMISSIONS_REQUIRED')
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await privatePath(path, true)
}

function cast(rootDirectory) {
  const executable = process.env.AGENTCITY_CAST || join(rootDirectory, '.local/tools/foundry-linux/cast')
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 })
  if (version.status !== 0 || !/^cast Version: 1\.7\.1\b/m.test(version.stdout)) throw Error('PINNED_CAST_1_7_1_REQUIRED')
  return executable
}

export async function ensureTestnetKeystore({ rootDirectory = ROOT, privateRoot, keyId, environment = PUBLIC_ENV }) {
  if (![PUBLIC_ENV, LOCAL_ENV].includes(environment) || !/^(role-(developer|market-issuer|world-registrar|world-publisher|world-faucet|treasury|liquidity)|player-[a-f0-9-]{36})$/.test(keyId) ||
      (environment === PUBLIC_ENV && !['role-developer', 'role-market-issuer','role-world-registrar','role-world-publisher','role-world-faucet'].includes(keyId))) throw Error('TESTNET_KEY_CONTEXT_REQUIRED')
  const root = privateRoot || join(homedir(), '.local/share/agentcity-playable-testnet', createHash('sha256').update(resolve(rootDirectory)).digest('hex').slice(0, 16), environment)
  const executable = cast(rootDirectory)
  // The existing reviewed unlock helper invokes `cast` by name. Pin that lookup
  // to the same checked binary used for standard encrypted-keystore creation.
  if (!process.env.PATH?.split(delimiter).includes(dirname(executable))) process.env.PATH = dirname(executable) + delimiter + (process.env.PATH || '')
  await privateDirectory(root)
  const directory = join(root, keyId)
  await privateDirectory(directory)
  const passwordFile = join(directory, 'password')
  try { await writeFile(passwordFile, randomBytes(48).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await privatePath(passwordFile)
  const keystore = join(directory, 'keystore')
  try { await privatePath(keystore) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const password = (await readFile(passwordFile, 'utf8')).trim()
    const generated = spawnSync(executable, ['wallet', 'new', directory, 'keystore'],
      { env: { ...process.env, CAST_PASSWORD: password }, encoding: 'utf8', timeout: 30000, maxBuffer: 8192 })
    if (generated.status !== 0) throw Error('TESTNET_ENCRYPTED_KEYSTORE_CREATION_FAILED')
    await chmod(keystore, 0o600)
    await privatePath(keystore)
  }
  const account = await openDevelopmentKeystore({ keystore, passwordFile })
  return { address: account.address.toLowerCase(), keystore, passwordFile, privateRoot: root }
}

// Stable policy fingerprints omit provider-assigned IDs and display labels.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : value
export const privyPolicyFingerprint = policy => createHash('sha256').update(JSON.stringify(sorted({
  chain_type: policy.chain_type, version: policy.version,
  rules: policy.rules.map(rule => ({ method: rule.method, action: rule.action, conditions: rule.conditions }))
}))).digest('hex')

export function buildPrivyMarketPolicies(manifest, treasuryRecipients = []) {
  if (!['agentcity.playable-market.v1','agentcity.playable-market.v2'].includes(manifest?.schema) || manifest.environment !== PUBLIC_ENV || manifest.chainId !== 1301 ||
      manifest.rpcUrl !== 'https://sepolia.unichain.org' || !ADDRESS.test(manifest.router) ||
      !ADDRESS.test(manifest.tokens?.CITY?.address) || !ADDRESS.test(manifest.tokens?.GEM?.address) ||
      !/^[1-9][0-9]*$/.test(manifest.maxInputBaseUnits || '') || treasuryRecipients.some(address => !ADDRESS.test(address))) {
    throw Error('VERIFIED_PUBLIC_PLAYABLE_MARKET_REQUIRED_FOR_POLICY')
  }
  if (manifest.exactOutputEnabled !== undefined && typeof manifest.exactOutputEnabled !== 'boolean') throw Error('VERIFIED_PUBLIC_PLAYABLE_MARKET_REQUIRED_FOR_POLICY')
  const cap = manifest.maxInputBaseUnits
  const transaction = (field, value) => ({ field_source: 'ethereum_transaction', field, operator: 'eq', value })
  const calldata = (abi, field, operator, value) => ({ field_source: 'ethereum_calldata', abi, field: abi[0].name + '.' + field, operator, value })
  const base = address => [transaction('chain_id', '1301'), transaction('to', address.toLowerCase()), transaction('value', '0')]
  const approve = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }]
  const swap = [{ type: 'function', name: 'swapExactInput', stateMutability: 'nonpayable', inputs: [
    { name: 'operationId', type: 'bytes32' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint128' }, { name: 'deadline', type: 'uint48' }], outputs: [{ name: 'amountOut', type: 'uint256' }] }]
  const rules = ['CITY', 'GEM'].map(name => ({ name: 'Bounded ' + name + ' router approval',
    method: 'eth_signTransaction', action: 'ALLOW', conditions: [...base(manifest.tokens[name].address),
      calldata(approve, 'spender', 'eq', manifest.router.toLowerCase()), calldata(approve, 'amount', 'lte', cap)] }))
  rules.push({ name: 'Bounded fixed-pool swap', method: 'eth_signTransaction', action: 'ALLOW', conditions: [...base(manifest.router),
    calldata(swap, 'amountIn', 'lte', cap), calldata(swap, 'minAmountOut', 'gte', '1')] })
  if (manifest.exactOutputEnabled) {
    const exactOutput = [{ type:'function',name:'swapExactOutput',stateMutability:'nonpayable',inputs:[
      {name:'operationId',type:'bytes32'},{name:'zeroForOne',type:'bool'},{name:'amountOut',type:'uint128'},
      {name:'maxAmountIn',type:'uint128'},{name:'deadline',type:'uint48'}],outputs:[{name:'amountIn',type:'uint256'}] }]
    rules.push({name:'Bounded fixed-pool exact-output swap',method:'eth_signTransaction',action:'ALLOW',conditions:[
      ...base(manifest.router),calldata(exactOutput,'maxAmountIn','lte',cap),calldata(exactOutput,'amountOut','gte','1')]})
  }
  const player = { version: '1.0', chain_type: 'ethereum', rules }
  let treasury = null
  if (treasuryRecipients.length) {
    const transfer = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }]
    treasury = { version: '1.0', chain_type: 'ethereum', rules: [{ name: 'Capped CITY payouts to enrolled managed wallets',
      method: 'eth_signTransaction', action: 'ALLOW', conditions: [...base(manifest.tokens.CITY.address),
        calldata(transfer, 'to', 'in', [...new Set(treasuryRecipients.map(address => address.toLowerCase()))].sort()),
        calldata(transfer, 'value', 'lte', '128000000000000000000')] }] }
  }
  // Every other RPC method, including export and raw/message signatures, is
  // absent and therefore denied by Privy's policy engine.
  return { player, treasury, allowedTargets: [...new Set([manifest.router, manifest.tokens.CITY.address, manifest.tokens.GEM.address].map(address => address.toLowerCase()))] }
}

export function createPrivyManagedProvider({ appId, appSecret, authorizationPrivateKey, ownerPublicKey,
  delegateAuthorizationPrivateKey, delegatePublicKey, delegateQuorumId, ownerQuorumId,
  policyId, policySha256, allowedTargets, rolePolicies = {}, client: suppliedClient } = {}) {
  if (authorizationPrivateKey !== undefined) throw Error('OFFLINE_OWNER_KEY_FORBIDDEN_IN_WALLET_RUNTIME')
  if (![appId, appSecret, delegateAuthorizationPrivateKey, delegatePublicKey, delegateQuorumId, ownerQuorumId, ownerPublicKey, policyId].every(value => typeof value === 'string' && value.length > 0) ||
      !/^[a-f0-9]{64}$/.test(policySha256 || '') || !Array.isArray(allowedTargets) || !allowedTargets.length ||
      allowedTargets.some(address => !ADDRESS.test(address))) throw Error('PRIVY_CREDENTIALS_AUTHORIZATION_KEY_AND_POLICY_REQUIRED')
  const derivedPublic = createPublicKey(createPrivateKey({ key: Buffer.from(delegateAuthorizationPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })).export({ type: 'spki', format: 'der' }).toString('base64')
  if (derivedPublic !== delegatePublicKey || derivedPublic === ownerPublicKey || delegateQuorumId === ownerQuorumId) throw Error('DISTINCT_OFFLINE_OWNER_AND_SCOPED_DELEGATE_REQUIRED')
  let sdk = suppliedClient
  const getSdk = async () => {
    if (!sdk) { const { PrivyClient } = await import('@privy-io/node'); sdk = new PrivyClient({ appId, appSecret, maxRetries: 0, timeout: 15000 }) }
    return sdk
  }
  const targets = new Set(allowedTargets.map(address => address.toLowerCase()))
  async function verifyAuthority() {
    const api = await getSdk()
    for (const [id, key] of [[ownerQuorumId, ownerPublicKey], [delegateQuorumId, delegatePublicKey]]) {
      const quorum = await api.keyQuorums().get(id)
      if (quorum.id !== id || quorum.authorization_threshold !== 1 || quorum.authorization_keys?.length !== 1 ||
        quorum.authorization_keys[0].public_key !== key || (quorum.user_ids?.length ?? 0) !== 0 || (quorum.key_quorum_ids?.length ?? 0) !== 0) throw Error('PRIVY_AUTHORITY_QUORUM_CHANGED')
    }
  }
  async function verifyPolicy(role) {
    const selected = role ? rolePolicies[role] : { policyId, policySha256 }
    const context = selected && { policyId: selected.policyId ?? selected.id, policySha256: selected.policySha256 ?? selected.sha256 }
    if (!context?.policyId || !/^[a-f0-9]{64}$/.test(context.policySha256 || '')) throw Error('PRIVY_ROLE_POLICY_REQUIRED')
    let policy
    try { policy = await (await getSdk()).policies().get(context.policyId) } catch { throw Error('PRIVY_POLICY_UNAVAILABLE') }
    if (policy.id !== context.policyId || policy.owner_id !== ownerQuorumId || policy.chain_type !== 'ethereum' || privyPolicyFingerprint(policy) !== context.policySha256) throw Error('PRIVY_POLICY_CHANGED')
    const allowed = policy.rules.filter(rule => rule.action === 'ALLOW')
    // Omitted methods are denied by Privy's enclave. Never permit export, raw
    // signatures, message signing, or a provider-side send/broadcast method.
    if (!allowed.length || allowed.some(rule => rule.method !== 'eth_signTransaction')) throw Error('PRIVY_POLICY_TOO_BROAD')
    for (const rule of allowed) {
      const has = (field, operator, expected) => rule.conditions.some(condition => condition.field_source === 'ethereum_transaction' &&
        condition.field === field && condition.operator === operator && String(condition.value) === expected)
      const restrictedTarget = rule.conditions.some(condition => condition.field_source === 'ethereum_transaction' && condition.field === 'to' &&
        ['eq', 'in'].includes(condition.operator) && (Array.isArray(condition.value) ? condition.value : [condition.value]).every(address => targets.has(String(address).toLowerCase())))
      if (!has('chain_id', 'eq', '1301') || !has('value', 'eq', '0') || !restrictedTarget ||
          !rule.conditions.some(condition => condition.field_source === 'ethereum_calldata' && condition.abi)) throw Error('PRIVY_POLICY_TRANSACTION_RESTRICTIONS_REQUIRED')
    }
    return context.policyId
  }
  function validateWallet(wallet, externalId, expectedPolicyId) {
    if (!wallet || !ADDRESS.test(wallet.address) || wallet.chain_type !== 'ethereum' || wallet.external_id !== externalId ||
        !Array.isArray(wallet.policy_ids) || wallet.policy_ids.length !== 1 || wallet.policy_ids[0] !== expectedPolicyId ||
        wallet.owner_id !== ownerQuorumId || wallet.additional_signers?.length !== 1 ||
        wallet.additional_signers[0].signer_id !== delegateQuorumId || wallet.additional_signers[0].override_policy_ids?.length !== 1 ||
        wallet.additional_signers[0].override_policy_ids[0] !== expectedPolicyId || wallet.exported_at != null) throw Error('PRIVY_WALLET_BINDING_CHANGED')
    return { address: wallet.address.toLowerCase(), accountId: wallet.id, externalId, policyId: expectedPolicyId }
  }
  return {
    kind: 'privy',
    async validateConfiguration({ role } = {}) {
      await verifyAuthority()
      const verifiedPolicyId = await verifyPolicy(role)
      return { provider: 'privy', ownerQuorumId, delegateQuorumId, policyId: verifiedPolicyId, walletCreationAttempted: false }
    },
    async ensureWallet({ externalId, role }) {
      await verifyAuthority()
      const expectedPolicyId = await verifyPolicy(role)
      let wallet
      try { wallet = await sdk.wallets().get('ext_wal_' + externalId) }
      catch (error) {
        if (error.status !== 404) throw Error('PRIVY_WALLET_LOOKUP_FAILED')
        try {
          wallet = await sdk.wallets().create({ chain_type: 'ethereum', external_id: externalId,
            display_name: 'AgentCity testnet wallet', owner_id: ownerQuorumId,
            additional_signers: [{ signer_id: delegateQuorumId, override_policy_ids: [expectedPolicyId] }], policy_ids: [expectedPolicyId], idempotency_key: externalId })
        } catch { throw Error('PRIVY_WALLET_CREATION_UNCERTAIN_RETRY_EXTERNAL_ID') }
      }
      return validateWallet(wallet, externalId, expectedPolicyId)
    },
    async signTransaction({ accountId, externalId, transaction, operationId, role }) {
      await verifyAuthority()
      const expectedPolicyId = await verifyPolicy(role)
      validateWallet(await sdk.wallets().get(accountId), externalId, expectedPolicyId)
      try {
        const result = await sdk.wallets().ethereum().signTransaction(accountId, {
          params: { transaction: { chain_id: toHex(transaction.chainId), type: 2, from: transaction.from,
            to: transaction.to, nonce: toHex(transaction.nonce), gas_limit: toHex(BigInt(transaction.gas)),
            max_fee_per_gas: toHex(BigInt(transaction.maxFeePerGas)), max_priority_fee_per_gas: toHex(BigInt(transaction.maxPriorityFeePerGas)),
            value: toHex(BigInt(transaction.value)), data: transaction.data } },
          idempotency_key: operationId, request_expiry: Date.now() + 60000,
          authorization_context: { authorization_private_keys: [delegateAuthorizationPrivateKey] }
        })
        if (result.encoding !== 'rlp' || !/^0x[a-f0-9]+$/i.test(result.signed_transaction)) throw Error('invalid_response')
        return { rawTransaction: result.signed_transaction, reference: operationId }
      } catch (error) {
        const reason = typeof error.error === 'string' ? error.error : typeof error.error?.message === 'string' ? error.error.message : typeof error.error?.error === 'string' ? error.error.error : null
        const safeReason = reason && [appSecret, delegateAuthorizationPrivateKey].reduce((message, secret) => message.split(secret).join('[redacted]'), reason).slice(0, 1000)
        throw Object.assign(Error('PRIVY_SIGNING_UNCERTAIN_RETRY_ORIGINAL_INTENT'), {
          providerStatus: Number.isInteger(error.status) ? error.status : null, providerReason: safeReason })
      }
    }
  }
}

export async function loadPrivySettings(rootDirectory = ROOT, { requireProvider = true } = {}) {
  let settings
  try { settings = JSON.parse(await readFile(join(rootDirectory, '.local/playable-testnet/wallet-settings.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw Error('MANAGED_WALLET_SETTINGS_REQUIRED'); throw error }
  if (settings.provider !== 'privy' || typeof settings.appId !== 'string' || typeof settings.credentialsFile !== 'string') throw Error('PRIVY_SETTINGS_REQUIRED')
  await privatePath(dirname(settings.credentialsFile), true)
  await privatePath(settings.credentialsFile)
  const credentials = JSON.parse(await readFile(settings.credentialsFile, 'utf8'))
  if (typeof credentials.appSecret !== 'string' || !credentials.appSecret.trim()) throw Error('PRIVY_PRIVATE_APP_SECRET_REQUIRED')
  if (!requireProvider) return { settings, credentials, provider: undefined }
  if (credentials.authorizationPrivateKey !== undefined || typeof credentials.delegateAuthorizationPrivateKey !== 'string' || typeof credentials.ownerPublicKey !== 'string') throw Error('OFFLINE_OWNER_SEPARATION_REQUIRED')
  const provider = createPrivyManagedProvider({ appId: settings.appId, appSecret: credentials.appSecret,
    delegateAuthorizationPrivateKey: credentials.delegateAuthorizationPrivateKey, delegatePublicKey: credentials.delegatePublicKey,
    delegateQuorumId: settings.delegateQuorumId, ownerQuorumId: settings.ownerQuorumId, ownerPublicKey: credentials.ownerPublicKey,
    policyId: settings.policyId, policySha256: settings.policySha256, allowedTargets: settings.allowedTargets, rolePolicies: settings.rolePolicies })
  return { settings, credentials, provider }
}

// Operator-only account provisioning from an already verified human login.
// This deliberately grants no game session or transaction authorization.
export async function verifyProvisioningIdentity({ pool, playerName, appId, enrollment, personalAgents, nowMs = Date.now() }) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(playerName || '') || !appId || !Array.isArray(personalAgents?.agents)) throw Error('PROVISIONING_PLAYER_CONFIGURATION_REQUIRED')
  const matches = personalAgents.agents.filter(agent => agent.ownerName === playerName)
  if (matches.length !== 1 || !UUID.test(matches[0].ownerId || '')) throw Error('PROVISIONING_EXACT_OWNED_PLAYER_REQUIRED')
  const playerId = matches[0].ownerId.toLowerCase()
  const row = (await pool.query(`SELECT b.player_id,b.player_name,b.privy_subject,b.app_id,s.expires_at,s.authenticated_at,
    s.expires_at>CURRENT_TIMESTAMP AS session_valid,s.authenticated_at<=CURRENT_TIMESTAMP AS authenticated_before_now
    FROM ac_wallet_identity_bindings b JOIN ac_wallet_verified_sessions s
    ON s.player_id=b.player_id AND s.privy_subject=b.privy_subject WHERE b.player_id=$1`, [playerId])).rows[0]
  if (!row || row.player_name !== playerName || row.app_id !== appId || enrollment?.[playerId] !== row.privy_subject ||
    !/^did:privy:[A-Za-z0-9:_-]+$/.test(row.privy_subject || '') || !Number.isFinite(+new Date(row.expires_at)) ||
    +new Date(row.expires_at) <= nowMs || row.session_valid !== true || !Number.isFinite(+new Date(row.authenticated_at)) || row.authenticated_before_now !== true) throw Error('VALID_VERIFIED_ENROLLED_SESSION_REQUIRED_FOR_PROVISIONING')
  return { playerId, playerName, subject: row.privy_subject, appId, expiresAt: new Date(row.expires_at).toISOString() }
}

// Explicit operator maintenance. The same database lock guards new treasury
// intents, so a policy version never changes under an unresolved payout.
export async function updatePrivyTreasuryPolicy({ pool, client, authorizationPrivateKey, previous, next, recipients, delegateQuorumId, ownerQuorumId }) {
  if (!delegateQuorumId || !ownerQuorumId || delegateQuorumId === ownerQuorumId) throw Error('OFFLINE_OWNER_AND_DELEGATE_QUORUMS_REQUIRED')
  const walletId = PUBLIC_ENV + ':role:treasury'
  const connection = await pool.connect()
  const lock = 'playable-treasury-policy:' + PUBLIC_ENV
  try {
    await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock])
    const wallet = (await connection.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1', [walletId])).rows[0]
    if (!wallet || wallet.provider_type !== 'privy') throw Error('EXISTING_MANAGED_TREASURY_REQUIRED')
    const pending = await connection.query(`SELECT 1 FROM ac_playable_testnet_requests r
      LEFT JOIN ac_playable_testnet_chain_intents i ON i.operation_id=r.operation_id
      WHERE r.wallet_id=$1 AND (i.status IS NULL OR i.status NOT IN ('confirmed','reverted')) LIMIT 1`, [walletId])
    if (pending.rowCount) throw Error('TREASURY_POLICY_PENDING_INTENTS_MUST_RECONCILE')
    const registered = (await connection.query(`SELECT address FROM ac_playable_testnet_wallets WHERE environment=$1
      AND provider_type='privy' AND auth_subject_hash IS NOT NULL`, [PUBLIC_ENV])).rows.map(row => row.address.toLowerCase())
    const boundedRecipients = [...new Set(recipients.map(address => address.toLowerCase()))].sort()
    if (!boundedRecipients.length || boundedRecipients.some(address => !registered.includes(address))) throw Error('REGISTERED_TREASURY_RECIPIENTS_REQUIRED')
    const newPolicy = await client.policies().get(next.policyId)
    if (newPolicy.owner_id !== ownerQuorumId || privyPolicyFingerprint(newPolicy) !== next.policySha256) throw Error('PRIVY_POLICY_CHANGED')
    const recipientCondition = newPolicy.rules.length === 1 && newPolicy.rules[0].conditions.find(condition =>
      condition.field_source === 'ethereum_calldata' && condition.field === 'transfer.to' && condition.operator === 'in')
    if (!recipientCondition || !isDeepStrictEqual(recipientCondition.value.map(address => address.toLowerCase()).sort(), boundedRecipients)) throw Error('TREASURY_POLICY_RECIPIENT_BINDING_CHANGED')
    const oldPolicy = await client.policies().get(previous.policyId)
    if (oldPolicy.owner_id !== ownerQuorumId || privyPolicyFingerprint(oldPolicy) !== previous.policySha256) throw Error('PRIVY_PREVIOUS_POLICY_CHANGED')
    await connection.query(`CREATE TABLE IF NOT EXISTS ac_playable_testnet_policy_audit(
      wallet_id text NOT NULL,old_policy_id text NOT NULL,new_policy_id text NOT NULL,old_sha256 text NOT NULL,new_sha256 text NOT NULL,
      provider_account_id text NOT NULL,address text NOT NULL,recipients jsonb NOT NULL,status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_id,new_policy_id))`)
    const audit = (await connection.query(`INSERT INTO ac_playable_testnet_policy_audit
      (wallet_id,old_policy_id,new_policy_id,old_sha256,new_sha256,provider_account_id,address,recipients,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'planned') ON CONFLICT DO NOTHING RETURNING *`,
      [walletId, previous.policyId, next.policyId, previous.policySha256, next.policySha256, wallet.provider_account_id, wallet.address, JSON.stringify(boundedRecipients)])).rows[0] ||
      (await connection.query('SELECT * FROM ac_playable_testnet_policy_audit WHERE wallet_id=$1 AND new_policy_id=$2', [walletId, next.policyId])).rows[0]
    if (audit.old_policy_id !== previous.policyId || audit.old_sha256 !== previous.policySha256 || audit.new_sha256 !== next.policySha256 ||
      audit.provider_account_id !== wallet.provider_account_id || !isDeepStrictEqual(audit.recipients, boundedRecipients)) throw Error('TREASURY_POLICY_AUDIT_BINDING_CONFLICT')
    const validate = actual => {
      if (actual.id !== wallet.provider_account_id || actual.address.toLowerCase() !== wallet.address || actual.external_id !== wallet.external_id ||
        actual.chain_type !== 'ethereum' || actual.owner_id !== ownerQuorumId || actual.additional_signers?.length !== 1 ||
        actual.additional_signers[0].signer_id !== delegateQuorumId || actual.additional_signers[0].override_policy_ids?.length !== 1 ||
        actual.additional_signers[0].override_policy_ids[0] !== actual.policy_ids?.[0] || actual.policy_ids?.length !== 1 || actual.exported_at != null) throw Error('PRIVY_WALLET_BINDING_CHANGED')
    }
    let actual = await client.wallets().get(wallet.provider_account_id)
    validate(actual)
    if (actual.policy_ids[0] !== next.policyId) {
      if (actual.policy_ids[0] !== previous.policyId) throw Error('PRIVY_PREVIOUS_WALLET_POLICY_CHANGED')
      await client.wallets().update(wallet.provider_account_id, { policy_ids: [next.policyId], request_expiry: Date.now() + 60000,
        additional_signers: [{ signer_id: delegateQuorumId, override_policy_ids: [next.policyId] }],
        authorization_context: { authorization_private_keys: [authorizationPrivateKey] } })
      actual = await client.wallets().get(wallet.provider_account_id)
      validate(actual)
      if (actual.policy_ids[0] !== next.policyId) throw Error('PRIVY_POLICY_UPDATE_UNCERTAIN_RETRY_SAME_VERSION')
    }
    await connection.query("UPDATE ac_playable_testnet_policy_audit SET status='confirmed' WHERE wallet_id=$1 AND new_policy_id=$2", [walletId, next.policyId])
    return { walletId, providerAccountId: wallet.provider_account_id, address: wallet.address, previous, next, recipients: boundedRecipients, status: 'confirmed' }
  } finally {
    await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock])
    connection.release()
  }
}

// Local fixtures must opt in explicitly. A missing managed provider never causes
// production player wallets to fall back to local keys.
export async function createTestnetWallets({ pool, rootDirectory = ROOT, environment = PUBLIC_ENV,
  chainId = 1301, rpcUrl = 'https://sepolia.unichain.org', genesisHash, allowBroadcast = false,
  allowedTargets = [], maxNativeBudgetWei = nativeCap, provider } = {}) {
  const local = environment === LOCAL_ENV && chainId === 31337 && ['http://127.0.0.1:8559', 'http://127.0.0.1:18559'].includes(rpcUrl)
  const publicChain = environment === PUBLIC_ENV && chainId === 1301 && rpcUrl === 'https://sepolia.unichain.org'
  if ((!local && !publicChain) || !pool?.connect || !/^0x[a-f0-9]{64}$/i.test(genesisHash || '') ||
      allowedTargets.some(address => !ADDRESS.test(address)) || BigInt(maxNativeBudgetWei) > nativeCap || BigInt(maxNativeBudgetWei) <= 0n ||
      (provider && (!provider.ensureWallet || !provider.signTransaction || (publicChain && provider.kind !== 'privy')))) throw Error('BOUNDED_TESTNET_WALLET_CONFIGURATION_REQUIRED')
  const chain = publicChain ? unichainSepolia : foundry
  const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) })
  const targets = new Set(allowedTargets.map(address => address.toLowerCase()))
  const rewrite = sql => sql.replace(/\bac_chain_/g, 'ac_playable_testnet_chain_')
  const store = {
    query: (sql, parameters) => pool.query(rewrite(sql), parameters),
    transaction: async work => {
      const tx = await pool.connect()
      try { await tx.query('BEGIN'); const result = await work({ query: (sql, parameters) => tx.query(rewrite(sql), parameters) }); await tx.query('COMMIT'); return result }
      catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }
  }
  await pool.query(rewrite(await readFile(new URL('../chain/schema.sql', import.meta.url), 'utf8')))
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_playable_testnet_wallets(
    wallet_id text PRIMARY KEY,environment text NOT NULL,address text UNIQUE NOT NULL,
    provider_type text NOT NULL,provider_account_id text NOT NULL,external_id text UNIQUE NOT NULL,auth_subject_hash text);
    ALTER TABLE ac_playable_testnet_wallets ADD COLUMN IF NOT EXISTS auth_subject_hash text;
    CREATE TABLE IF NOT EXISTS ac_playable_testnet_requests(
    operation_id uuid PRIMARY KEY,wallet_id text NOT NULL REFERENCES ac_playable_testnet_wallets(wallet_id),binding jsonb NOT NULL,
    unsigned_request jsonb,signing_status text NOT NULL DEFAULT 'bound',provider_reference text);`)
  const engine = () => new DurableEvm({ store, rpcUrl, genesisHash, chain })
  const visible = intent => ({ operationId: intent.operation_id, hash: intent.transaction_hash, status: intent.status,
    sender: intent.account, from: intent.account, to: intent.destination, data: intent.calldata, nonce: String(intent.nonce), chainId })
  function owner(input) {
    if (input.role !== undefined) {
      if (input.playerId !== undefined || !ROLES.has(input.role)) throw Error('TESTNET_SIGNER_ROLE_REQUIRED')
      return 'role:' + input.role
    }
    if (!UUID.test(input.playerId)) throw Error('TESTNET_WALLET_PLAYER_REQUIRED')
    return input.playerId.toLowerCase()
  }
  async function wallet(id, subject) {
    const player = UUID.test(id), role = id.startsWith('role:') ? id.slice(5) : null
    if (!player && !ROLES.has(role)) throw Error('TESTNET_WALLET_OWNER_REQUIRED')
    if (!provider) throw Error('MANAGED_WALLET_PROVIDER_NOT_CONFIGURED')
    const walletId = environment + ':' + (player ? id.toLowerCase() : 'role:' + role)
    if (subject !== undefined && !/^did:privy:[a-z0-9]+$/i.test(subject)) throw Error('VERIFIED_PRIVY_SUBJECT_REQUIRED')
    const subjectHash = subject === undefined ? null : createHash('sha256').update(subject).digest('hex')
    return store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['playable-provider-wallet:' + walletId])
      let row = (await tx.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1', [walletId])).rows[0]
      if (publicChain && player && ((!row && !subjectHash) || (row && subjectHash && row.auth_subject_hash !== subjectHash))) throw Error('VERIFIED_PRIVY_PLAYER_BINDING_REQUIRED')
      const externalId = row?.external_id || 'ac_' + createHash('sha256').update(resolve(rootDirectory) + ':' + walletId + ':' + (subjectHash || '')).digest('hex').slice(0, 60)
      const account = await provider.ensureWallet({ externalId, ...(role ? { role } : {}) })
      if (!ADDRESS.test(account.address) || !account.accountId || account.externalId !== externalId) throw Error('MANAGED_WALLET_RESPONSE_INVALID')
      if (!row) row = (await tx.query(`INSERT INTO ac_playable_testnet_wallets(wallet_id,environment,address,provider_type,provider_account_id,external_id,auth_subject_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [walletId, environment, account.address.toLowerCase(), provider.kind, account.accountId, externalId, subjectHash])).rows[0]
      if (row.address !== account.address.toLowerCase() || row.provider_account_id !== account.accountId || row.provider_type !== provider.kind || row.external_id !== externalId) throw Error('MANAGED_WALLET_BINDING_CHANGED')
      return row
    })
  }
  async function boundIntent(input) {
    if (!UUID.test(input.operationId)) throw Error('TESTNET_OPERATION_ID_REQUIRED')
    // Existing receipts remain reconcilable during a signing-provider outage.
    // Never provision a new account merely to inspect a retained operation.
    const walletId = environment + ':' + owner(input)
    const row = (await pool.query('SELECT * FROM ac_playable_testnet_wallets WHERE wallet_id=$1', [walletId])).rows[0]
    if (!row) throw Error('TESTNET_INTENT_OWNER_REQUIRED')
    const subject = input.subject ?? input.authSubject
    if (subject !== undefined && row.auth_subject_hash !== createHash('sha256').update(subject).digest('hex')) throw Error('VERIFIED_PRIVY_PLAYER_BINDING_REQUIRED')
    const request = (await pool.query('SELECT * FROM ac_playable_testnet_requests WHERE operation_id=$1 AND wallet_id=$2', [input.operationId, row.wallet_id])).rows[0]
    if (!request) throw Error('TESTNET_INTENT_OWNER_REQUIRED')
    return { request, row }
  }
  const cost = transaction => BigInt(transaction.gas) * BigInt(transaction.maxFeePerGas) + BigInt(transaction.value || 0n)
  const restore = transaction => ({ ...transaction, gas: BigInt(transaction.gas), maxFeePerGas: BigInt(transaction.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), value: BigInt(transaction.value) })

  async function prepare(input) {
    if (!UUID.test(input.operationId) || !ADDRESS.test(input.to) || !/^0x([a-f0-9]{2})*$/i.test(input.data) ||
        !targets.has(input.to.toLowerCase()) || BigInt(input.value ?? 0n) !== 0n) throw Error('TESTNET_EXACT_ALLOWED_ZERO_VALUE_CALL_REQUIRED')
    const limits = input.limits || {}
    if (!Number.isSafeInteger(limits.maxGas) || limits.maxGas < 21000 || limits.maxGas > 1000000 ||
        BigInt(limits.maxNativeCostWei ?? 0n) <= 0n || BigInt(limits.maxNativeCostWei) > BigInt(maxNativeBudgetWei)) throw Error('TESTNET_CALL_BUDGET_REQUIRED')
    const row = await wallet(owner(input), input.subject ?? input.authSubject)
    const binding = normalized({ to: input.to.toLowerCase(), data: input.data.toLowerCase(), value: 0n, limits })
    // Reserve the exact unsigned transaction and nonce before asking a remote
    // provider to sign. An uncertain provider reply keeps this reservation.
    let record = await store.transaction(async tx => {
      if (publicChain && input.role === 'treasury') await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['playable-treasury-policy:' + environment])
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['playable-intent:' + input.operationId])
      await tx.query('INSERT INTO ac_playable_testnet_requests(operation_id,wallet_id,binding) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [input.operationId, row.wallet_id, binding])
      const request = (await tx.query('SELECT * FROM ac_playable_testnet_requests WHERE operation_id=$1 FOR UPDATE', [input.operationId])).rows[0]
      if (request.wallet_id !== row.wallet_id || !isDeepStrictEqual(request.binding, binding)) throw Error('TESTNET_OPERATION_BINDING_CONFLICT')
      if (request.unsigned_request) return request
      await engine().verify()
      await tx.query('INSERT INTO ac_chain_nonces(chain_instance,account,next_nonce) VALUES($1,$2,0) ON CONFLICT DO NOTHING', [engine().instance, row.address])
      const counter = (await tx.query('SELECT next_nonce FROM ac_chain_nonces WHERE chain_instance=$1 AND account=$2 FOR UPDATE', [engine().instance, row.address])).rows[0]
      const nonce = Math.max(Number(counter.next_nonce), await client.getTransactionCount({ address: row.address, blockTag: 'pending' }))
      if (!Number.isSafeInteger(nonce)) throw Error('TESTNET_NONCE_OVERFLOW')
      const rpcWallet = createWalletClient({ account: row.address, chain, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) })
      const prepared = await rpcWallet.prepareTransactionRequest({ account: row.address, to: binding.to, data: binding.data, value: 0n, nonce, type: 'eip1559' })
      const unsigned = normalized({ chainId, from: row.address, to: binding.to, data: binding.data, value: 0n, nonce,
        gas: prepared.gas, maxFeePerGas: prepared.maxFeePerGas, maxPriorityFeePerGas: prepared.maxPriorityFeePerGas, type: 'eip1559' })
      if (BigInt(unsigned.gas) > BigInt(limits.maxGas) || cost(unsigned) > BigInt(limits.maxNativeCostWei)) throw Error('TESTNET_TRANSACTION_LIMIT_EXCEEDED')
      const reserved = (await tx.query('SELECT unsigned_request FROM ac_playable_testnet_requests WHERE wallet_id=$1 AND unsigned_request IS NOT NULL', [row.wallet_id])).rows
      if (reserved.reduce((sum, value) => sum + cost(value.unsigned_request), 0n) + cost(unsigned) > BigInt(maxNativeBudgetWei)) throw Error('TESTNET_WALLET_NATIVE_BUDGET_EXHAUSTED')
      await tx.query('UPDATE ac_chain_nonces SET next_nonce=$3 WHERE chain_instance=$1 AND account=$2', [engine().instance, row.address, nonce + 1])
      return (await tx.query("UPDATE ac_playable_testnet_requests SET unsigned_request=$2,signing_status='reserved' WHERE operation_id=$1 RETURNING *", [input.operationId, unsigned])).rows[0]
    })
    const existing = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [input.operationId])).rows[0]
    if (existing) return visible(existing)
    let signed
    try {
      await pool.query("UPDATE ac_playable_testnet_requests SET signing_status='signing' WHERE operation_id=$1", [input.operationId])
      signed = await provider.signTransaction({ accountId: row.provider_account_id, externalId: row.external_id,
        transaction: record.unsigned_request, operationId: input.operationId, ...(input.role ? { role: input.role } : {}) })
    } catch (error) {
      await pool.query("UPDATE ac_playable_testnet_requests SET signing_status='unknown' WHERE operation_id=$1", [input.operationId])
      throw Object.assign(Error('MANAGED_SIGNING_UNCERTAIN_RETRY_SAME_INTENT'), { providerStatus: error.providerStatus ?? null, providerReason: error.providerReason ?? null })
    }
    const parsed = parseTransaction(signed.rawTransaction)
    const recovered = (await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction })).toLowerCase()
    const expected = restore(record.unsigned_request)
    if (recovered !== row.address || parsed.chainId !== chainId || parsed.to?.toLowerCase() !== expected.to ||
        (parsed.data || '0x').toLowerCase() !== expected.data || Number(parsed.nonce) !== expected.nonce ||
        BigInt(parsed.value || 0n) !== expected.value || parsed.gas !== expected.gas || parsed.maxFeePerGas !== expected.maxFeePerGas ||
        parsed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas) throw Error('MANAGED_SIGNATURE_TRANSACTION_MISMATCH')
    const hash = keccak256(signed.rawTransaction)
    const intent = await store.transaction(async tx => {
      await tx.query('SELECT operation_id FROM ac_playable_testnet_requests WHERE operation_id=$1 FOR UPDATE', [input.operationId])
      await tx.query(`INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_id) DO NOTHING`,
      [input.operationId, engine().instance, row.address, expected.to, expected.data, expected.nonce, signed.rawTransaction, hash])
      const saved = (await tx.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [input.operationId])).rows[0]
      if (saved.transaction_hash !== hash || saved.account !== row.address) throw Error('MANAGED_SIGNATURE_INTENT_CONFLICT')
      await tx.query("UPDATE ac_playable_testnet_requests SET signing_status='signed',provider_reference=$2 WHERE operation_id=$1", [input.operationId, signed.reference || input.operationId])
      return saved
    })
    return visible(intent)
  }

  return {
    provider: provider?.kind || 'not_configured', managedProviderConfigured: Boolean(provider),
    getOrCreate: async (playerId, context = {}) => { const row = await wallet(playerId, context.subject); return { ...publicWallet(row.wallet_id, row.address, chainId), provider: row.provider_type } },
    getRoleWallet: async role => { const row = await wallet('role:' + role); return { ...publicWallet(row.wallet_id, row.address, chainId), provider: row.provider_type } },
    publicStatus: async (playerId, context = {}) => {
      const row = await wallet(playerId, context.subject); await engine().verify()
      const balance = await client.getBalance({ address: row.address })
      return { ...publicWallet(row.wallet_id, row.address, chainId), provider: row.provider_type,
        nativeBalanceWei: String(balance), fundedBalancePresent: balance > 0n }
    },
    prepare,
    broadcast: async input => {
      if (allowBroadcast !== true) throw Error('TESTNET_BROADCAST_NOT_AUTHORIZED')
      await boundIntent(input)
      return engine().broadcast(input.operationId)
    },
    reconcile: async input => {
      const { request } = await boundIntent(input)
      const intent = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [input.operationId])).rows[0]
      if (!intent) return { operationId: input.operationId, status: 'signing_' + request.signing_status, hash: null, chainId, canonical: false }
      const result = await engine().receipt(input.operationId, local ? 1 : 2)
      return normalized({ ...visible(intent), ...result, transactionHash: result.hash, canonical: ['confirmed', 'reverted'].includes(result.status) })
    },
    client
  }
}
