import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { createTestnetWallets, createPrivyManagedProvider, privyPolicyFingerprint, buildPrivyMarketPolicies, updatePrivyTreasuryPolicy, verifyProvisioningIdentity } from '../../backend/src/playable/testnet-wallets.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { Pool } = require('pg')
const { createPublicClient, http, toHex, keccak256 } = require('viem')
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts')
const { foundry } = require('viem/chains')
const settings = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
const schema = 'test_playable_wallets_' + randomUUID().replaceAll('-', '')
const admin = new Pool({ connectionString: settings.databaseUrl, max: 1 })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c search_path=' + schema, max: 4 })
const rpcUrl = 'http://127.0.0.1:18559'
const client = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0, timeout: 3000 }) })
const target = '0x000000000000000000000000000000000000dead'
const checks = []
const report = { scope: 'Real isolated PostgreSQL and owned Anvil18559; explicit in-memory fixture signing provider and mocked Privy SDK API shape. No live provider wallet/signature, production qualification, public transaction or human-key proof.',
  status: 'fail', checks, publicTransactions: 0, localTransactions: 0 }
const check = name => { checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
let anvil, createdSchema = false
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
try {
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port: 18559, exclusive: true }, resolve) })
  await new Promise(resolve => probe.close(resolve))
  const executable = process.platform === 'darwin' ? join(homedir(), '.foundry/bin/anvil')
    : join(root, '.local/tools', process.platform === 'win32' ? 'foundry/anvil.exe' : 'foundry-linux/anvil')
  anvil = spawn(executable, ['--host', '127.0.0.1', '--port', '18559', '--chain-id', '31337', '--silent'], { stdio: 'ignore', windowsHide: true })
  anvil.on('error', () => {})
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if (await client.getChainId() === 31337) break } catch {}
    if (attempt === 39) throw Error('Owned Anvil fixture did not start')
    await delay(100)
  }
  const genesisHash = (await client.getBlock({ blockNumber: 0n })).hash
  await admin.query('CREATE SCHEMA ' + schema); createdSchema = true
  const accounts = new Map(), signingRequests = []
  let loseNextSignature = false
  const provider = { kind: 'local_fixture',
    async ensureWallet({ externalId }) {
      if (!accounts.has(externalId)) accounts.set(externalId, privateKeyToAccount(generatePrivateKey()))
      return { address: accounts.get(externalId).address.toLowerCase(), accountId: 'fixture-' + externalId, externalId }
    },
    async signTransaction({ accountId, externalId, transaction, operationId }) {
      assert.equal(accountId, 'fixture-' + externalId)
      signingRequests.push({ operationId, transaction: structuredClone(transaction) })
      const { from, ...unsigned } = transaction
      const rawTransaction = await accounts.get(externalId).signTransaction({ ...unsigned,
        gas: BigInt(unsigned.gas), value: BigInt(unsigned.value), maxFeePerGas: BigInt(unsigned.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas) })
      if (loseNextSignature) { loseNextSignature = false; throw Error('fixture_lost_provider_reply') }
      return { rawTransaction, reference: operationId }
    } }
  const options = { pool, rootDirectory: root, environment: 'LOCAL_TEST_FIXTURE', chainId: 31337,
    rpcUrl, genesisHash, provider, allowedTargets: [target] }
  const wallets = await createTestnetWallets(options)
  const playerId = randomUUID(), otherId = randomUUID()
  const publicWallet = await wallets.getOrCreate(playerId)
  assert.equal(publicWallet.provider, 'local_fixture')
  assert.deepEqual(await wallets.getOrCreate(playerId), publicWallet)
  const treasury = await wallets.getRoleWallet('treasury')
  assert.notEqual(publicWallet.address, treasury.address)
  assert.equal(JSON.stringify(publicWallet).includes('private'), false)
  await client.request({ method: 'anvil_setBalance', params: [publicWallet.address, toHex(5000000000000000n)] })
  check('explicit local fixture wallets bind stably to players and separate roles without exporting keys')

  const operationId = randomUUID()
  const input = { playerId, operationId, to: target, data: '0x', value: 0n,
    limits: { maxGas: 100000, maxNativeCostWei: 1000000000000000n } }
  const prepared = await wallets.prepare(input)
  assert.equal(prepared.nonce, '0'); assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.raw_transaction, undefined); assert.equal(prepared.rawTransaction, undefined)
  const stored = (await pool.query('SELECT raw_transaction,transaction_hash FROM ac_playable_testnet_chain_intents WHERE operation_id=$1', [operationId])).rows[0]
  assert.equal(keccak256(stored.raw_transaction), prepared.hash)
  assert.deepEqual(await wallets.prepare(input), prepared)
  assert.equal(signingRequests.length, 1)
  assert.equal(await client.getTransactionCount({ address: publicWallet.address }), 0)
  await assert.rejects(wallets.broadcast({ playerId, operationId }), /TESTNET_BROADCAST_NOT_AUTHORIZED/)
  await assert.rejects(wallets.prepare({ ...input, data: '0x01' }), /TESTNET_OPERATION_BINDING_CONFLICT/)
  await assert.rejects(wallets.reconcile({ playerId: otherId, operationId }), /TESTNET_INTENT_OWNER_REQUIRED/)
  check('exact request nonce and signed bytes persist before broadcast; retries and owner checks retain the same intent')

  const enabled = await createTestnetWallets({ ...options, allowBroadcast: true })
  assert.equal((await enabled.broadcast({ playerId, operationId })).hash, prepared.hash)
  await client.waitForTransactionReceipt({ hash: prepared.hash })
  const confirmed = await enabled.reconcile({ playerId, operationId })
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.canonical, true)
  assert.equal(confirmed.receipt.transactionHash, prepared.hash)
  await enabled.broadcast({ playerId, operationId })
  assert.equal(await client.getTransactionCount({ address: publicWallet.address }), 1)
  report.localTransactions++
  check('actual local broadcast and canonical receipt reconciliation replay the original transaction hash')

  const uncertainId = randomUUID()
  loseNextSignature = true
  await assert.rejects(enabled.prepare({ ...input, operationId: uncertainId }), /MANAGED_SIGNING_UNCERTAIN_RETRY_SAME_INTENT/)
  const unresolved = await enabled.reconcile({ playerId, operationId: uncertainId })
  assert.equal(unresolved.status, 'signing_unknown'); assert.equal(unresolved.hash, null)
  const retained = (await pool.query('SELECT unsigned_request FROM ac_playable_testnet_requests WHERE operation_id=$1', [uncertainId])).rows[0].unsigned_request
  assert.equal(retained.nonce, 1)
  const recovered = await enabled.prepare({ ...input, operationId: uncertainId })
  assert.equal(recovered.nonce, '1')
  assert.deepEqual(signingRequests.at(-1).transaction, signingRequests.at(-2).transaction)
  await enabled.broadcast({ playerId, operationId: uncertainId })
  await client.waitForTransactionReceipt({ hash: recovered.hash })
  assert.equal((await enabled.reconcile({ playerId, operationId: uncertainId })).status, 'confirmed')
  assert.equal(await client.getTransactionCount({ address: publicWallet.address }), 2)
  report.localTransactions++
  check('lost provider reply retains its exact unsigned transaction and nonce before signing and broadcasting once')

  await assert.rejects(createTestnetWallets({ ...options, chainId: 1 }), /BOUNDED_TESTNET_WALLET_CONFIGURATION_REQUIRED/)
  const missingProvider = await createTestnetWallets({ pool, rootDirectory: root, environment: 'UNICHAIN_SEPOLIA_PLAYABLE',
    chainId: 1301, rpcUrl: 'https://sepolia.unichain.org', genesisHash, allowedTargets: [target] })
  await assert.rejects(missingProvider.getOrCreate(randomUUID()), /MANAGED_WALLET_PROVIDER_NOT_CONFIGURED/)
  await assert.rejects(enabled.prepare({ ...input, operationId: randomUUID(), to: '0x0000000000000000000000000000000000000002' }), /TESTNET_EXACT_ALLOWED_ZERO_VALUE_CALL_REQUIRED/)
  await assert.rejects(enabled.prepare({ ...input, operationId: randomUUID(), value: 1n }), /TESTNET_EXACT_ALLOWED_ZERO_VALUE_CALL_REQUIRED/)
  check('mainnet unapproved recipients value spending and silent local custody fallback are refused')

  const policy = { id: 'fixture-policy', owner_id: 'fixture-owner-quorum', chain_type: 'ethereum', version: '1.0', rules: [{ name: 'Bounded approval', action: 'ALLOW', method: 'eth_signTransaction', conditions: [
    { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '1301' },
    { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: target },
    { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
    { field_source: 'ethereum_calldata', field: 'amount', operator: 'lte', value: '100',
      abi: [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] }
  ] }] }
  let apiWallet, createCount = 0, observedRequest
  const p256Fixture = () => { const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } }
  const fixtureOwnerKey = p256Fixture(), fixtureDelegateKey = p256Fixture()
  const fixtureAuthority = { ownerQuorumId: 'fixture-owner-quorum', delegateQuorumId: 'fixture-delegate-quorum' }
  const api = { keyQuorums: () => ({ get: async id => ({ id, authorization_threshold: 1, user_ids: [], key_quorum_ids: [],
    authorization_keys: [{ public_key: id === fixtureAuthority.ownerQuorumId ? fixtureOwnerKey.publicKey : fixtureDelegateKey.publicKey }] }) }),
    policies: () => ({ get: async () => policy }), wallets: () => ({
    get: async id => { if (!apiWallet) { const error = Error('fixture_not_found'); error.status = 404; throw error } return apiWallet },
    create: async request => { createCount++; assert.equal(request.owner_id, fixtureAuthority.ownerQuorumId);
      apiWallet = { id: 'fixture-wallet', owner_id: request.owner_id, address: publicWallet.address, external_id: request.external_id, chain_type: 'ethereum', policy_ids: request.policy_ids, additional_signers: request.additional_signers, exported_at: null }; return apiWallet },
    ethereum: () => ({ signTransaction: async (id, request) => { observedRequest = request; return { encoding: 'rlp', signed_transaction: '0x01' } } }) }) }
  const providerSettings = { appId: 'fixture-app', appSecret: 'fixture-app-secret', delegateAuthorizationPrivateKey: fixtureDelegateKey.privateKey,
    delegatePublicKey: fixtureDelegateKey.publicKey, ownerPublicKey: fixtureOwnerKey.publicKey, ...fixtureAuthority,
    policyId: policy.id, policySha256: privyPolicyFingerprint(policy), allowedTargets: [target], client: api }
  assert.throws(() => createPrivyManagedProvider({ ...providerSettings, authorizationPrivateKey: fixtureOwnerKey.privateKey }), /OFFLINE_OWNER_KEY_FORBIDDEN/)
  assert.throws(() => createPrivyManagedProvider({ ...providerSettings, delegateAuthorizationPrivateKey: fixtureOwnerKey.privateKey, delegatePublicKey: fixtureOwnerKey.publicKey }), /DISTINCT_OFFLINE_OWNER/)
  const privy = createPrivyManagedProvider(providerSettings)
  assert.equal((await privy.validateConfiguration()).walletCreationAttempted, false)
  assert.equal(createCount, 0)
  const managed = await privy.ensureWallet({ externalId: 'fixture-external-id' })
  assert.deepEqual(await privy.ensureWallet({ externalId: 'fixture-external-id' }), managed)
  assert.equal(createCount, 1)
  await privy.signTransaction({ accountId: managed.accountId, externalId: managed.externalId, operationId,
    transaction: { ...retained, chainId: 1301 } })
  assert.equal(observedRequest.idempotency_key, operationId)
  assert.equal(observedRequest.params.transaction.chain_id, '0x515')
  assert.equal(observedRequest.authorization_context.authorization_private_keys.length, 1)
  assert.equal(observedRequest.authorization_context.authorization_private_keys[0], fixtureDelegateKey.privateKey)
  assert.equal(privy.exportPrivateKey, undefined)
  apiWallet.additional_signers[0].override_policy_ids = []
  await assert.rejects(privy.ensureWallet({ externalId: 'fixture-external-id' }), /PRIVY_WALLET_BINDING_CHANGED/)
  apiWallet.additional_signers[0].override_policy_ids = [policy.id]
  policy.rules[0].conditions[0].value = '1'
  await assert.rejects(privy.ensureWallet({ externalId: 'fixture-external-id' }), /PRIVY_POLICY_CHANGED/)
  check('official Privy SDK-shaped fixture pins offline owner and scoped delegate rejects owner runtime keys and broad delegates')
  const fixtureManifest = { schema: 'agentcity.playable-market.v1', environment: 'UNICHAIN_SEPOLIA_PLAYABLE', chainId: 1301,
    rpcUrl: 'https://sepolia.unichain.org', router: target, maxInputBaseUnits: '100',
    tokens: { CITY: { address: '0x0000000000000000000000000000000000000011' }, GEM: { address: '0x0000000000000000000000000000000000000012' } } }
  assert.equal(buildPrivyMarketPolicies(fixtureManifest).treasury, null)
  const templates = buildPrivyMarketPolicies(fixtureManifest, [publicWallet.address])
  assert.equal(templates.player.rules.length, 3)
  const exactOutputRules = buildPrivyMarketPolicies({...fixtureManifest,exactOutputEnabled:true}).player.rules
  assert.equal(exactOutputRules.length,4)
  const exactOutputCap = exactOutputRules.at(-1).conditions.find(condition => condition.field === 'swapExactOutput.maxAmountIn')
  assert.equal(exactOutputCap.operator,'lte');assert.equal(exactOutputCap.value,fixtureManifest.maxInputBaseUnits)
  assert(exactOutputRules.at(-1).conditions.some(condition => condition.field === 'swapExactOutput.amountOut' && condition.operator === 'gte' && condition.value === '1'))
  assert.throws(() => buildPrivyMarketPolicies({...fixtureManifest,exactOutputEnabled:'true'}),/VERIFIED_PUBLIC_PLAYABLE_MARKET_REQUIRED/)
  assert.equal(templates.treasury.rules.length, 1)
  assert(templates.player.rules.every(rule => rule.method === 'eth_signTransaction' &&
    rule.conditions.filter(condition => condition.field_source === 'ethereum_calldata').every(condition => condition.abi[0].name !== 'transfer')))
  const recipientBound = templates.treasury.rules[0].conditions.find(condition => condition.field_source === 'ethereum_calldata' && condition.field === 'transfer.to')
  assert.deepEqual(recipientBound.value, [publicWallet.address.toLowerCase()])
  assert.equal(recipientBound.operator, 'in')
  assert.throws(() => buildPrivyMarketPolicies({ ...fixtureManifest, chainId: 1 }), /VERIFIED_PUBLIC_PLAYABLE_MARKET_REQUIRED/)
  check('policy templates separate bounded player approve/swap from recipient-restricted treasury transfer and reject mainnet')
  // Public-provider administration fixture only: no provider or chain calls.
  const adminRecipients = [1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase())
  const adminTreasuryAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const adminWalletId = 'UNICHAIN_SEPOLIA_PLAYABLE:role:treasury'
  for (const [index, address] of [adminTreasuryAddress, ...adminRecipients].entries()) await pool.query(`INSERT INTO ac_playable_testnet_wallets
    (wallet_id,environment,address,provider_type,provider_account_id,external_id,auth_subject_hash) VALUES($1,$2,$3,'privy',$4,$5,$6)`,
    [index === 0 ? adminWalletId : 'fixture-public-player-' + index, 'UNICHAIN_SEPOLIA_PLAYABLE', address, 'fixture-admin-' + index, 'fixture-admin-ext-' + index, index ? 'fixture-auth-hash-' + index : null])
  const oldTreasuryPolicy = { ...buildPrivyMarketPolicies(fixtureManifest, adminRecipients.slice(0, 1)).treasury, id: 'fixture-treasury-old', owner_id: fixtureAuthority.ownerQuorumId }
  const newTreasuryPolicy = { ...buildPrivyMarketPolicies(fixtureManifest, adminRecipients).treasury, id: 'fixture-treasury-new', owner_id: fixtureAuthority.ownerQuorumId }
  const policyVersions = new Map([[oldTreasuryPolicy.id, oldTreasuryPolicy], [newTreasuryPolicy.id, newTreasuryPolicy]])
  let actualTreasury = { id: 'fixture-admin-0', owner_id: fixtureAuthority.ownerQuorumId, address: adminTreasuryAddress, external_id: 'fixture-admin-ext-0', chain_type: 'ethereum', policy_ids: [oldTreasuryPolicy.id], additional_signers: [{ signer_id: fixtureAuthority.delegateQuorumId, override_policy_ids: [oldTreasuryPolicy.id] }] }
  let updateCount = 0
  const adminApi = { policies: () => ({ get: async id => policyVersions.get(id) }), wallets: () => ({
    get: async () => actualTreasury, update: async (id, input) => { assert.equal(id, actualTreasury.id); assert.equal(input.authorization_context.authorization_private_keys.length, 1);
      updateCount++; actualTreasury = { ...actualTreasury, policy_ids: input.policy_ids, additional_signers: input.additional_signers }; return actualTreasury } }) }
  const maintenance = { pool, client: adminApi, authorizationPrivateKey: 'fixture-owner-key', ...fixtureAuthority,
    previous: { policyId: oldTreasuryPolicy.id, policySha256: privyPolicyFingerprint(oldTreasuryPolicy) },
    next: { policyId: newTreasuryPolicy.id, policySha256: privyPolicyFingerprint(newTreasuryPolicy) }, recipients: adminRecipients }
  const pendingAdminId = randomUUID()
  await pool.query("INSERT INTO ac_playable_testnet_requests(operation_id,wallet_id,binding,signing_status) VALUES($1,$2,'{}','unknown')", [pendingAdminId, adminWalletId])
  await assert.rejects(updatePrivyTreasuryPolicy(maintenance), /TREASURY_POLICY_PENDING_INTENTS_MUST_RECONCILE/)
  assert.equal(updateCount, 0)
  await pool.query('DELETE FROM ac_playable_testnet_requests WHERE operation_id=$1', [pendingAdminId])
  const policyUpdate = await updatePrivyTreasuryPolicy(maintenance)
  assert.equal(policyUpdate.address, adminTreasuryAddress)
  assert.equal(policyUpdate.status, 'confirmed')
  await updatePrivyTreasuryPolicy(maintenance)
  assert.equal(updateCount, 1)
  assert.equal((await pool.query('SELECT status FROM ac_playable_testnet_policy_audit')).rows[0].status, 'confirmed')
  check('explicit treasury policy expansion preserves wallet address audits pinned versions replays once and refuses unresolved payouts')
  await pool.query(`CREATE TABLE ac_wallet_identity_bindings(player_id uuid PRIMARY KEY,player_name text,privy_subject text,app_id text);
    CREATE TABLE ac_wallet_verified_sessions(player_id uuid PRIMARY KEY,privy_subject text,expires_at timestamptz,authenticated_at timestamptz)`)
  const provisionId = randomUUID(), provisionSubject = 'did:privy:fixtureonly'
  await pool.query('INSERT INTO ac_wallet_identity_bindings VALUES($1,$2,$3,$4)', [provisionId, 'FixturePlayer', provisionSubject, 'fixture-app'])
  await pool.query("INSERT INTO ac_wallet_verified_sessions VALUES($1,$2,now()+interval '10 minutes',now())", [provisionId, provisionSubject])
  const provisionInput = { pool, playerName: 'FixturePlayer', appId: 'fixture-app', enrollment: { [provisionId]: provisionSubject },
    personalAgents: { agents: [{ ownerId: provisionId, ownerName: 'FixturePlayer' }] } }
  assert.equal((await verifyProvisioningIdentity(provisionInput)).playerId, provisionId)
  await assert.rejects(verifyProvisioningIdentity({ ...provisionInput, enrollment: { [provisionId]: 'did:privy:somebodyelse' } }), /VALID_VERIFIED_ENROLLED_SESSION_REQUIRED/)
  await pool.query("UPDATE ac_wallet_verified_sessions SET expires_at=now()-interval '1 second' WHERE player_id=$1", [provisionId])
  await assert.rejects(verifyProvisioningIdentity(provisionInput), /VALID_VERIFIED_ENROLLED_SESSION_REQUIRED/)
  check('operator account provisioning requires exact owned UUID app enrollment and unexpired persisted verified human session')
  report.status = 'pass'
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await pool.end()
  if (createdSchema) await admin.query('DROP SCHEMA ' + schema + ' CASCADE')
  await admin.end()
  if (anvil && anvil.exitCode === null) { anvil.kill(); await delay(300) }
  const output = new URL(`../../evidence/runs/playable-testnet-wallets/${randomUUID()}/`, import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence: output.href, error: report.error }))
}
