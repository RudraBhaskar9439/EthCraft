// Isolated PostgreSQL, injected native/Privy bindings and chain receipts. No real signing or network calls.
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { createInventoryGameFunding } from '../../backend/src/playable/inventory-game-funding.mjs'
import { PublicTestnetEvm } from '../../backend/src/chain/public-testnet.mjs'
import { createBankOperatorWallets, TEST_CITY_GRANT_TOKEN, TEST_GAME_CITY_AMOUNT, TEST_GAME_NATIVE_AMOUNT,
  testGameGrantOperationIds, validateTestGameGrant } from '../../backend/src/bank/operator-wallets.mjs'
const { parseAbi, encodeFunctionData, encodeEventTopics, encodeAbiParameters, keccak256 } = createRequire(new URL('../../backend/package.json', import.meta.url))('viem')
const { privateKeyToAccount } = createRequire(new URL('../../backend/package.json', import.meta.url))('viem/accounts')
const abi = parseAbi(['function transfer(address to,uint256 value) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)'])
const environment = JSON.parse(await readFile(new URL('../../.local/backend/environment.json', import.meta.url), 'utf8'))
const schema = 'test_game_grant_' + randomUUID().replaceAll('-', ''), walletSchema = 'test_game_grant_wallet_' + randomUUID().replaceAll('-', '')
const admin = new pg.Pool({ connectionString: environment.databaseUrl, max: 1 }), pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 4, options: '-c search_path=' + schema })
const principalId = randomUUID(), recipient = '0x' + '2'.repeat(40), source = '0x' + '3'.repeat(40), subject = 'did:privy:fixturegamestarter'
const binding = { principalId, recipient, walletId: 'UNICHAIN_SEPOLIA_PLAYABLE:' + principalId, subjectHash: createHash('sha256').update(subject).digest('hex') }
const manifest = { mode: 'marketplace', chainId: 1301, city: TEST_CITY_GRANT_TOKEN, serverId: '0x' + '1'.repeat(64), deploymentId: '0x' + '2'.repeat(64), maxNativeCostWei: '500000000000000' }
const ids = testGameGrantOperationIds(manifest, binding), hashes = { city: '0x' + '4'.repeat(64), native: '0x' + '5'.repeat(64) }, blockHash = '0x' + '6'.repeat(64)
const cityData = encodeFunctionData({ abi, functionName: 'transfer', args: [recipient, TEST_GAME_CITY_AMOUNT] })
const limits = { maxGas: 100000, maxNativeCostWei: manifest.maxNativeCostWei }
const cityInput = { operationId: ids.city, to: manifest.city, data: cityData, value: 0n, limits }
const nativeInput = { operationId: ids.native, to: recipient, data: '0x', value: TEST_GAME_NATIVE_AMOUNT, limits }
assert.equal(validateTestGameGrant(manifest, binding, cityInput), 'city')
assert.equal(validateTestGameGrant(manifest, binding, nativeInput), 'native')
for (const input of [{ ...nativeInput, to: source }, { ...nativeInput, value: TEST_GAME_NATIVE_AMOUNT + 1n }, { ...nativeInput, data: '0x00' }, { ...cityInput, operationId: randomUUID() },
  { ...cityInput, data: encodeFunctionData({ abi, functionName: 'transfer', args: [recipient, TEST_GAME_CITY_AMOUNT + 1n] }) }]) assert.throws(() => validateTestGameGrant(manifest, binding, input), /EXACT_TRANSFER_REQUIRED/)
assert.notEqual(ids.city, ids.native)
console.log('PASS exact two-purpose transfer scope rejects redirection, extra value/calldata, replacement IDs and changed CITY amount')
let nativeApproved = true, allowed = false, changedRecipient = recipient, preflights = 0, stages = 0, canonical = true
const intents = new Map(), transactions = new Map()
let fixtureDirectory
const originalPrepare = PublicTestnetEvm.prototype.prepare, originalReceipt = PublicTestnetEvm.prototype.receipt, originalPath = process.env.PATH
const signer = { address: source, operationIds: ids, preflight: async () => { preflights++ }, prepare: async input => {
  const leg = validateTestGameGrant(manifest, binding, input)
  intents.set(input.operationId, input)
  transactions.set(hashes[leg], { from: source, to: input.to, input: input.data, value: input.value })
  return { hash: hashes[leg], status: 'prepared' }
}, broadcast: async () => ({ status: 'unknown' }), reconcile: async ({ operationId }) => {
  const leg = operationId === ids.city ? 'city' : 'native'
  if (stages < (leg === 'city' ? 1 : 2)) return { status: 'unknown', hash: hashes[leg] }
  return { status: 'confirmed', hash: hashes[leg], receipt: { status: 'success', blockNumber: 10n, blockHash, logs: leg === 'city' ? [{ address: manifest.city,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: source, to: recipient } }), data: encodeAbiParameters([{ type: 'uint256' }], [TEST_GAME_CITY_AMOUNT]) }] : [] } }
} }
try {
  await admin.query('CREATE SCHEMA ' + schema)
  const funding = await createInventoryGameFunding({ pool, manifest, wallets: { testGameGrant: async value => ({ ...signer, operationIds: testGameGrantOperationIds(manifest, value) }) },
    client: { getTransaction: async ({ hash }) => transactions.get(hash), getBlockNumber: async () => 11n, getBlock: async () => ({ hash: canonical ? blockHash : '0x' + '7'.repeat(64) }) },
    resolveIdentity: async ({ principalId }) => ({ principalId, privySubject: subject, walletId: 'UNICHAIN_SEPOLIA_PLAYABLE:' + principalId,
      walletAddress: changedRecipient, nativeApproved, managedWalletVerified: true }), authorize: async request => ({ ...request, authorized: allowed }) })
  nativeApproved = false
  await assert.rejects(funding.preview({ principalId }), /VERIFIED_MANAGED_WALLET_REQUIRED/); assert.equal(intents.size, 0)
  nativeApproved = true
  const preview = await funding.preview({ principalId }), consent = { principalId, termsDigest: preview.termsDigest, confirmationId: randomUUID() }
  assert.equal(preview.consented, false); assert.equal(intents.size, 0)
  await assert.rejects(funding.confirm(consent), /EXPLICIT_CONFIRMATION_REQUIRED/); assert.equal(intents.size, 0)
  allowed = true
  assert.equal((await funding.confirm(consent)).status, 'funding'); assert.equal(intents.size, 1)
  stages = 1
  canonical = false
  await assert.rejects(funding.confirm(consent), /CANONICAL_RECEIPT_REQUIRED/)
  assert.equal((await pool.query('SELECT city_receipt FROM ac_inventory_game_starter_grants')).rows[0].city_receipt, null)
  canonical = true
  const partial = await funding.confirm(consent)
  assert.equal(partial.status, 'funding'); assert(partial.cityReceipt); assert.equal(partial.nativeReceipt, null); assert.equal(intents.size, 2)
  stages = 2
  const complete = await funding.confirm(consent)
  assert.equal(complete.status, 'complete'); assert(complete.cityReceipt && complete.nativeReceipt)
  assert.equal((await funding.confirm(consent)).status, 'complete'); assert.equal(intents.size, 2); assert.equal(preflights, 1)
  await assert.rejects(funding.preview({ principalId: randomUUID() }), /QUOTA_OR_BINDING_CONFLICT/)
  changedRecipient = source
  await assert.rejects(funding.preview({ principalId }), /QUOTA_OR_BINDING_CONFLICT/); changedRecipient = recipient
  await assert.rejects(pool.query("UPDATE ac_inventory_game_starter_grants SET state='preview' WHERE grant_id=1"), /STARTER_GRANT_IMMUTABLE/)
  await assert.rejects(pool.query('UPDATE ac_inventory_game_starter_grants SET recipient=$1 WHERE grant_id=1', [source]), /STARTER_GRANT_IMMUTABLE/)
  console.log('PASS readonly financial preview, explicit native consent, one original transfer per leg across unknown replies, two canonical receipts and immutable singleton quota')
  await pool.query(`CREATE TABLE ac_playable_testnet_wallets(wallet_id text,environment text,address text,provider_type text,provider_account_id text,auth_subject_hash text);
    CREATE TABLE ac_discord_wallet_aliases(wallet_id text,principal_id uuid,address text,provider_account_id text);
    CREATE TABLE ac_discord_principals(principal_id uuid,privy_subject text); CREATE TABLE ac_discord_identities(principal_id uuid);`)
  await pool.query('INSERT INTO ac_playable_testnet_wallets VALUES($1,$2,$3,$4,$5,$6)', [binding.walletId, 'UNICHAIN_SEPOLIA_PLAYABLE', recipient, 'privy', 'fixture-provider-wallet', binding.subjectHash])
  await pool.query('INSERT INTO ac_discord_wallet_aliases VALUES($1,$2,$3,$4)', [binding.walletId, principalId, recipient, 'fixture-provider-wallet'])
  await pool.query('INSERT INTO ac_discord_principals VALUES($1,$2)', [principalId, subject]); await pool.query('INSERT INTO ac_discord_identities VALUES($1)', [principalId])
  const root = new URL('../..', import.meta.url).pathname, actual = JSON.parse(await readFile(new URL('../../.local/marketplace/public-deployment.json', import.meta.url), 'utf8'))
  const settings = JSON.parse(await readFile(new URL('../../.local/bank/operator-settings.json', import.meta.url), 'utf8'))
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'agentcity-starter-fixture-'))
  const fixturePrivateKey = '0x' + '1'.repeat(64), fixtureAccount = privateKeyToAccount(fixturePrivateKey)
  const keystore = join(fixtureDirectory, 'fixture-keystore'), passwordFile = join(fixtureDirectory, 'fixture-password')
  await writeFile(keystore, 'Disclosed fixture only; the test cast stub returns a known test key.', { mode: 0o600 })
  await writeFile(passwordFile, 'fixture-only', { mode: 0o600 })
  await writeFile(join(fixtureDirectory, 'cast'), "#!/bin/sh\nprintf '%s\\n' '" + fixturePrivateKey + "'\n", { mode: 0o700 })
  settings.actors.seller.wallet = { address: fixtureAccount.address, keystore, passwordFile }
  let rpcReads = 0, cityCodeReads = 0, cityBalance = 10n ** 20n, allowance = 0n, nativeBalance = 10n ** 18n
  const pinned = { ...actual, journalSchema: walletSchema, codeHashes: { ...actual.codeHashes, city: keccak256('0x6001') } }
  const operator = await createBankOperatorWallets({ rootDirectory: root, pool, manifest: pinned, settings, client: {
    getChainId: async () => { rpcReads++; return 1301 }, getBlock: async () => ({ hash: actual.genesisHash }), getCode: async ({ address }) => { assert.equal(address, pinned.city); cityCodeReads++; return '0x6001' },
    readContract: async ({ functionName }) => functionName === 'balanceOf' ? cityBalance : allowance, getBalance: async () => nativeBalance
  } })
  const scoped = await operator.testGameGrant(binding), scopedIds = testGameGrantOperationIds(pinned, binding)
  await assert.rejects(operator.testGameGrant({ ...binding, recipient: source }), /VERIFIED_PRIVY_WALLET_REQUIRED/)
  await assert.rejects(operator.testGameGrant({ ...binding, subjectHash: '0'.repeat(64) }), /VERIFIED_PRIVY_WALLET_REQUIRED/)
  await assert.rejects(scoped.prepare({ ...nativeInput, operationId: scopedIds.native, to: source }), /EXACT_TRANSFER_REQUIRED/)
  await assert.rejects(scoped.prepare({ ...cityInput, operationId: randomUUID() }), /EXACT_TRANSFER_REQUIRED/)
  await assert.rejects(operator.prepare({ ...nativeInput, playerId: settings.actors.seller.principalId }), /BOUNDED_CALL_REQUIRED/)
  assert.equal(rpcReads, 0)
  await pool.query("UPDATE ac_playable_testnet_wallets SET provider_type='fixture'")
  await assert.rejects(operator.testGameGrant(binding), /VERIFIED_PRIVY_WALLET_REQUIRED/)
  await pool.query("UPDATE ac_playable_testnet_wallets SET provider_type='privy'")
  await scoped.preflight()
  let nativePrepared = 0, nativeReconciled = 0
  PublicTestnetEvm.prototype.prepare = async function (operationId, account, to, data, value) {
    assert.equal(operationId, scopedIds.native); assert.equal(account.address, fixtureAccount.address)
    assert.equal(to, recipient); assert.equal(data, '0x'); assert.equal(value, TEST_GAME_NATIVE_AMOUNT)
    assert.equal(this.store, operator.store); assert.equal(this.nativeCap, BigInt(pinned.maximumNativeBudgetWei))
    nativePrepared++; return { transaction_hash: hashes.native, status: 'prepared' }
  }
  PublicTestnetEvm.prototype.receipt = async function (operationId, confirmations) {
    assert.equal(operationId, scopedIds.native); assert.equal(confirmations, 2); assert.equal(this.store, operator.store)
    nativeReconciled++; return { hash: hashes.native, status: 'confirmed' }
  }
  process.env.PATH = fixtureDirectory + ':' + originalPath
  assert.equal((await scoped.prepare({ ...nativeInput, operationId: scopedIds.native })).hash, hashes.native)
  assert.equal((await scoped.reconcile({ operationId: scopedIds.native })).status, 'confirmed')
  process.env.PATH = originalPath
  PublicTestnetEvm.prototype.prepare = originalPrepare; PublicTestnetEvm.prototype.receipt = originalReceipt
  assert.equal(nativePrepared, 1); assert.equal(nativeReconciled, 1); assert(cityCodeReads >= 4)
  console.log('PASS real native adapter forwards exact nonzero value into its original budget/store engine and reconciles through receipt(operation,2); only a disclosed fixture key and EVM spies were used')
  await pool.query(`DELETE FROM ${walletSchema}.bank_operator_bindings WHERE operation_id=$1`, [scopedIds.native])
  allowance = cityBalance
  await assert.rejects(scoped.preflight(), /DONOR_FREE_CITY_REQUIRED/); allowance = 0n
  nativeBalance = 0n
  await assert.rejects(scoped.preflight(), /DONOR_NATIVE_REQUIRED/); nativeBalance = 10n ** 18n
  await pool.query(`INSERT INTO ${walletSchema}.bank_operator_bindings VALUES($1,$2)`, [randomUUID(), { account: settings.actors.seller.wallet.address.toLowerCase() }])
  await assert.rejects(scoped.preflight(), /DONOR_PENDING_INTENT/)
  console.log('PASS actual operator adapter verifies canonical managed wallet/alias/subject, denies ordinary transfers, preserves original store, and checks free CITY/native funds plus pending authorizations without opening live keys')
} finally { process.env.PATH = originalPath; PublicTestnetEvm.prototype.prepare = originalPrepare; PublicTestnetEvm.prototype.receipt = originalReceipt;
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + walletSchema + ' CASCADE'); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end() }
