import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'
import { createBankRpcClient } from './rpc.mjs'
import { PostgresStore } from '../storage/postgres.mjs'
import { PublicTestnetEvm, TESTNET_NATIVE_CAP } from '../chain/public-testnet.mjs'
import { openDevelopmentKeystore } from '../chain/development-wallets.mjs'
import { stable, lower } from '../world-assets/canonical.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^0x[a-f0-9]{64}$/i
const fail = code => { throw Object.assign(Error(code), { code }) }
const TEST_CITY_GRANT = Symbol('fixed-current-CITY-onboarding')
const TEST_GAME_GRANT = Symbol('verified-Privy-game-starter')
const gameGrantAbi = parseAbi(['function transfer(address to,uint256 value) returns(bool)'])
export const TEST_GAME_CITY_AMOUNT = 10n ** 18n
export const TEST_GAME_NATIVE_AMOUNT = 100000000000000n
export function testGameGrantOperationIds(manifest, binding) {
  testCityGrantOperationId(manifest)
  if (!UUID.test(binding?.principalId || '') || binding.walletId !== 'UNICHAIN_SEPOLIA_PLAYABLE:' + binding.principalId.toLowerCase() ||
      !/^0x[a-f0-9]{40}$/i.test(binding.recipient || '') || !/^[a-f0-9]{64}$/.test(binding.subjectHash || '')) fail('BANK_TEST_GAME_GRANT_BINDING_REQUIRED')
  return Object.fromEntries(['grant', 'city', 'native'].map(leg => {
    const h = keccak256(stringToHex([manifest.serverId, manifest.deploymentId, 'privy-game-starter-v1', binding.principalId.toLowerCase(), binding.walletId,
      binding.recipient.toLowerCase(), binding.subjectHash, leg].join(':'))).slice(2, 34)
    return [leg, [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-')]
  }))
}
export function validateTestGameGrant(manifest, binding, input) {
  const ids = testGameGrantOperationIds(manifest, binding)
  if (input.playerId !== undefined || !/^0x[a-f0-9]*$/i.test(input.data || '')) fail('BANK_TEST_GAME_GRANT_EXACT_TRANSFER_REQUIRED')
  let leg
  if (input.operationId === ids.city) {
    const data = encodeFunctionData({ abi: gameGrantAbi, functionName: 'transfer', args: [binding.recipient, TEST_GAME_CITY_AMOUNT] })
    if (lower(input.to) !== manifest.city.toLowerCase() || BigInt(input.value || 0) !== 0n || input.data.toLowerCase() !== data.toLowerCase()) fail('BANK_TEST_GAME_GRANT_EXACT_TRANSFER_REQUIRED')
    leg = 'city'
  } else if (input.operationId === ids.native && lower(input.to) === binding.recipient.toLowerCase() && input.data === '0x' && BigInt(input.value || 0) === TEST_GAME_NATIVE_AMOUNT) leg = 'native'
  else fail('BANK_TEST_GAME_GRANT_EXACT_TRANSFER_REQUIRED')
  if (!Number.isInteger(input.limits?.maxGas) || input.limits.maxGas < 21000 || input.limits.maxGas > 100000 ||
      BigInt(input.limits?.maxNativeCostWei || 0) <= 0n || BigInt(input.limits.maxNativeCostWei) > BigInt(manifest.maxNativeCostWei)) fail('BANK_TEST_GAME_GRANT_GAS_CAP')
  return leg
}
export const TEST_CITY_GRANT_AMOUNT=100n*10n**18n
export const TEST_CITY_GRANT_RECIPIENT='0xd1dcaaff9356d5a42f2ee6f90179c4509386a83f'
export const TEST_CITY_GRANT_TOKEN='0x13431952927c79004fc2fc5aab576752552fea12'
export function testCityGrantOperationId(manifest){
  if(manifest?.mode!=='marketplace'||manifest.chainId!==1301||manifest.city?.toLowerCase()!==TEST_CITY_GRANT_TOKEN||!HASH.test(manifest.deploymentId||'')||!HASH.test(manifest.serverId||''))fail('BANK_TEST_CITY_GRANT_CURRENT_MARKETPLACE_REQUIRED')
  const h=keccak256(stringToHex(manifest.serverId+':'+manifest.deploymentId+':unirock-onboarding:'+TEST_CITY_GRANT_RECIPIENT)).slice(2,34)
  return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-')
}
export function validateTestCityGrant(manifest,input,decoded){
  if(input.operationId!==testCityGrantOperationId(manifest)||input.playerId!==undefined||lower(input.to)!==TEST_CITY_GRANT_TOKEN||
    BigInt(input.value||0)!==0n||decoded.functionName!=='transfer'||lower(decoded.args[0])!==TEST_CITY_GRANT_RECIPIENT||decoded.args[1]!==TEST_CITY_GRANT_AMOUNT)fail('BANK_TEST_CITY_GRANT_EXACT_TRANSFER_REQUIRED')
  if(!Number.isInteger(input.limits?.maxGas)||input.limits.maxGas<21000||input.limits.maxGas>100000||
    BigInt(input.limits?.maxNativeCostWei||0)<=0n||BigInt(input.limits.maxNativeCostWei)>BigInt(manifest.maxNativeCostWei))fail('BANK_TEST_CITY_GRANT_GAS_CAP')
}
const roleCalls = {
  registrar: { registry: ['mintItem', 'finalizeRedemption'] },
  publisher: { stateRegistry: ['publish'], hook: ['checkpoint'] },
  inspector: { workEscrow: ['startWork', 'recordCompletion'] }
}
const playerCalls = {
  bank: ['offerLoan', 'cancelOffer', 'takeLoan', 'repay', 'startAuction', 'bid', 'settleAuction', 'claimCollateral', 'withdraw'],
  router: ['swapExactOutput', 'buyWithSwap'],
  workEscrow: ['fundWork', 'acceptWork', 'refundWork'],
  registry: ['approve', 'requestRedemption'],
  market: ['list', 'cancel']
}
const artifacts = {
  city: 'PlayableMarketToken', gem: 'PlayableMarketToken', usdc: 'BankTestUSDC',
  registry: 'WorldAssetRegistry', market: 'WorldAssetMarket', bank: 'AgentCityBank',
  router: 'BankPaymentRouter', workEscrow: 'AgentCityWorkEscrow', stateRegistry: 'StateRegistry'
}

async function privateFile(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) {
    fail('BANK_OPERATOR_PRIVATE_FILE_REQUIRED')
  }
}

/** Local operator wallets only. This adapter never claims Privy or human consent. */
export async function createBankOperatorWallets({ rootDirectory, pool, manifest, settings, client: suppliedClient } = {}) {
  if (!pool?.connect || manifest?.chainId !== 1301 || manifest.environment !== 'UNICHAIN_SEPOLIA_BANK'
    || manifest.rpcUrl !== 'https://sepolia.unichain.org' || !HASH.test(manifest.genesisHash || '')
    || !/^[a-z][a-z0-9_]{1,62}$/.test(manifest.journalSchema || '')) fail('BANK_OPERATOR_PINNED_TESTNET_REQUIRED')
  const path = join(rootDirectory, '.local/bank/operator-settings.json')
  await privateFile(path)
  settings ||= JSON.parse(await readFile(path, 'utf8'))
  if (settings.schema !== 'agentcity.bank-operator.v1' || settings.chainId !== 1301
    || settings.operatorControlled !== true) fail('BANK_OPERATOR_DISCLOSURE_REQUIRED')
  const actors = Object.values(settings.actors || {})
  if (!actors.length || actors.some(value => !UUID.test(value.principalId || '') || value.operatorControlled !== true)) {
    fail('BANK_OPERATOR_TEST_ACTORS_REQUIRED')
  }
  const addresses = new Set([...Object.values(settings.roles || {}), ...actors.map(actor => actor.wallet)]
    .map(value => lower(value.address)))
  const client = suppliedClient || await createBankRpcClient(manifest)
  const schema = manifest.journalSchema
  await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
  const rewrite = sql => sql.replace(/\bac_chain_[a-z_]+\b/g, name => schema + '.' + name)
  const wrap = connection => ({ query: (sql, args) => connection.query(rewrite(sql), args), release: () => connection.release() })
  const store = Object.create(PostgresStore.prototype)
  store.pool = { query: (sql, args) => pool.query(rewrite(sql), args), connect: async () => wrap(await pool.connect()) }
  await store.query(await readFile(new URL('../chain/schema.sql', import.meta.url), 'utf8'))
  await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.bank_operator_bindings (
    operation_id uuid PRIMARY KEY, binding jsonb NOT NULL)`)
  const budget = BigInt(manifest.maximumNativeBudgetWei || 0)
  if (budget <= 0n || budget > TESTNET_NATIVE_CAP) fail('BANK_OPERATOR_TOTAL_GAS_BUDGET_REQUIRED')
  const engines = new Map(), abiByTarget = {}
  const activeArtifacts = { ...artifacts, ...(manifest.mode === 'marketplace' ? { hook: 'AgentCityMarketplaceHook' } : {}) }
  for (const [name, artifact] of Object.entries(activeArtifacts)) {
    const value = JSON.parse(await readFile(join(rootDirectory, 'contracts/out', artifact + '.sol', artifact + '.json'), 'utf8'))
    abiByTarget[name] = value.abi
  }

  async function verify(target) {
    if (await client.getChainId() !== 1301
      || (await client.getBlock({ blockNumber: 0n })).hash.toLowerCase() !== manifest.genesisHash.toLowerCase()) {
      fail('BANK_OPERATOR_CHAIN_CHANGED')
    }
    if (target === 'native') return verify('city')
    const code = await client.getCode({ address: manifest[target] })
    if (!code || keccak256(code).toLowerCase() !== manifest.codeHashes[target].toLowerCase()) {
      fail('BANK_OPERATOR_TARGET_CODE_CHANGED')
    }
  }

  function context(input, role) {
    if (role?.kind === TEST_GAME_GRANT) {
      const actor = settings.actors?.seller
      if (actor?.operatorControlled !== true || actor.role !== 'seller' || actor.minecraftUsername !== 'BankSeller' || !UUID.test(actor.principalId || '')) fail('BANK_TEST_GAME_GRANT_CONTROLLED_DONOR_REQUIRED')
      return { key: 'test-game-grant:' + role.binding.principalId, wallet: actor.wallet, actor }
    }
    if(role===TEST_CITY_GRANT){
      testCityGrantOperationId(manifest)
      const actor=settings.actors?.seller
      if(actor?.operatorControlled!==true||actor.role!=='seller'||actor.minecraftUsername!=='BankSeller'||!UUID.test(actor.principalId||''))fail('BANK_TEST_CITY_GRANT_CONTROLLED_DONOR_REQUIRED')
      return{key:'test-city-grant:'+actor.principalId,wallet:actor.wallet,calls:{city:['transfer']},actor}
    }
    if (role) {
      if (!roleCalls[role] || !settings.roles[role]) fail('BANK_OPERATOR_ROLE_DENIED')
      return { key: 'role:' + role, wallet: settings.roles[role], calls: roleCalls[role] }
    }
    const actor = actors.find(value => value.principalId === input.playerId)
    if (!actor) fail('BANK_OPERATOR_KNOWN_ACTOR_REQUIRED')
    return { key: actor.principalId, wallet: actor.wallet, calls: playerCalls, actor }
  }

  function checked(input, role) {
    const owner = context(input, role)
    if (role?.kind === TEST_GAME_GRANT) {
      const leg = validateTestGameGrant(manifest, role.binding, input)
      return { owner, target: leg, binding: { owner: owner.key, account: lower(owner.wallet.address), target: leg,
        to: lower(input.to), data: input.data.toLowerCase(), value: String(BigInt(input.value || 0)),
        maxGas: input.limits.maxGas, maxNativeCostWei: String(input.limits.maxNativeCostWei) } }
    }
    if (!UUID.test(input.operationId || '') || BigInt(input.value || 0) !== 0n
      || !/^0x[0-9a-f]+$/i.test(input.data || '') || input.data.length > 20000) fail('BANK_OPERATOR_BOUNDED_CALL_REQUIRED')
    const target = Object.keys(activeArtifacts).find(name => lower(manifest[name]) === lower(input.to))
    if (!target) fail('BANK_OPERATOR_TARGET_DENIED')
    if (manifest.mode === 'marketplace' && ['bank', 'gem'].includes(target)) fail('MARKETPLACE_TARGET_REQUIRED')
    let decoded
    try { decoded = decodeFunctionData({ abi: abiByTarget[target], data: input.data }) }
    catch { fail('BANK_OPERATOR_ABI_REQUIRED') }
    const token = ['city', 'gem', 'usdc'].includes(target)
    if(role===TEST_CITY_GRANT){
      if(target!=='city')fail('BANK_TEST_CITY_GRANT_EXACT_TRANSFER_REQUIRED')
      validateTestCityGrant(manifest,input,decoded)
    } else if (token) {
      if (role || decoded.functionName !== 'approve') fail('BANK_OPERATOR_TOKEN_CALL_DENIED')
      const [spender, amount] = decoded.args
      if (manifest.mode === 'marketplace' && lower(spender) === lower(manifest.bank)) fail('MARKETPLACE_TARGET_REQUIRED')
      if (!['bank', 'router', 'market', 'workEscrow'].some(name => lower(manifest[name]) === lower(spender))) {
        fail('BANK_OPERATOR_APPROVAL_TARGET_DENIED')
      }
      if (amount > (target === 'usdc' ? 100e6 : 100n * 10n ** 18n)) fail('BANK_OPERATOR_APPROVAL_CAP')
    } else if (!owner.calls[target]?.includes(decoded.functionName)) fail('BANK_OPERATOR_SELECTOR_DENIED')
    if (target === 'bank' && decoded.functionName === 'offerLoan' && owner.actor?.role !== 'lender') {
      fail('BANK_OPERATOR_LENDER_REQUIRED')
    }
    if (target === 'registry' && decoded.functionName === 'approve'
      && manifest.mode === 'marketplace' && lower(decoded.args[0]) === lower(manifest.bank)) fail('MARKETPLACE_TARGET_REQUIRED')
    if (target === 'registry' && decoded.functionName === 'approve'
      && !['bank', 'market'].some(name => lower(manifest[name]) === lower(decoded.args[0]))) {
      fail('BANK_OPERATOR_NFT_APPROVAL_DENIED')
    }
    if (target === 'registry' && decoded.functionName === 'mintItem'
      && String(decoded.args[1]).toLowerCase() !== manifest.serverId.toLowerCase()) fail('BANK_OPERATOR_NATIVE_NAMESPACE_REQUIRED')
    const maxGas = Number(input.limits?.maxGas), maximumCost = BigInt(input.limits?.maxNativeCostWei || 0)
    if (!Number.isSafeInteger(maxGas) || maxGas < 21000 || maxGas > Number(manifest.maxGas)
      || maximumCost <= 0n || maximumCost > BigInt(manifest.maxNativeCostWei)) fail('BANK_OPERATOR_GAS_CAP_REQUIRED')
    return { owner, target, binding: { owner: owner.key, account: lower(owner.wallet.address), target,
      to: lower(input.to), data: input.data.toLowerCase(), value: '0', maxGas, maxNativeCostWei: String(maximumCost) } }
  }

  function engine(limits) {
    const key = stable(limits)
    if (engines.has(key)) return engines.get(key)
    const value = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: manifest.rpcUrl,
      genesisHash: manifest.genesisHash, environment: 'PUBLIC_TESTNET_WORLD_ASSETS', allowedSigners: [...addresses] })
    value.nativeCap = budget
    const validate = value.validateRequest.bind(value)
    value.validateRequest = async (tx, request) => {
      if (BigInt(request.gas) > BigInt(limits.maxGas)
        || BigInt(request.gas) * BigInt(request.maxFeePerGas ?? request.gasPrice) > BigInt(limits.maxNativeCostWei)) {
        fail('BANK_OPERATOR_TRANSACTION_GAS_CAP')
      }
      await validate(tx, request)
    }
    engines.set(key, value)
    return value
  }

  async function retained(input, role) {
    const owner = context(input, role)
    if (!UUID.test(input.operationId || '')) fail('BANK_OPERATOR_OPERATION_REQUIRED')
    const row = (await pool.query(`SELECT binding FROM ${schema}.bank_operator_bindings WHERE operation_id=$1`, [input.operationId])).rows[0]
    if (!row || row.binding.owner !== owner.key || row.binding.account !== lower(owner.wallet.address)) {
      fail('BANK_OPERATOR_RETAINED_OWNER_REQUIRED')
    }
    const { binding } = checked({ ...input, to: row.binding.to, data: row.binding.data,
      value: BigInt(row.binding.value), limits: { maxGas: row.binding.maxGas,
        maxNativeCostWei: row.binding.maxNativeCostWei } }, role)
    if (stable(binding) !== stable(row.binding)) fail('BANK_OPERATOR_IMMUTABLE_INTENT_REQUIRED')
    await verify(row.binding.target)
    return row.binding
  }

  async function prepare(input, role) {
    const { owner, target, binding } = checked(input, role)
    await verify(target)
    await pool.query(`INSERT INTO ${schema}.bank_operator_bindings(operation_id,binding) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [input.operationId, binding])
    const saved = await retained(input, role)
    if (stable(saved) !== stable(binding)) fail('BANK_OPERATOR_IMMUTABLE_INTENT_REQUIRED')
    const old = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [input.operationId])).rows[0]
    if (old) {
      if (old.account !== binding.account || old.destination !== binding.to || old.calldata !== binding.data) {
        fail('BANK_OPERATOR_RETAINED_TRANSACTION_CHANGED')
      }
      return { operationId: input.operationId, hash: old.transaction_hash, transactionHash: old.transaction_hash, status: old.status }
    }
    await privateFile(owner.wallet.keystore)
    await privateFile(owner.wallet.passwordFile)
    const signer = await openDevelopmentKeystore(owner.wallet)
    const intent = await engine(binding).prepare(input.operationId, signer, binding.to, binding.data, BigInt(binding.value))
    return { operationId: input.operationId, hash: intent.transaction_hash, transactionHash: intent.transaction_hash, status: intent.status }
  }

  const api = role => ({
    ...(role ? { address: role===TEST_CITY_GRANT?settings.actors.seller.wallet.address:settings.roles[role].address } : {}),
    prepare: input => prepare(input, role),
    async broadcast(input) {
      const saved = await retained(input, role), value = await engine(saved).broadcast(input.operationId)
      return { ...value, transactionHash: value.hash }
    },
    async reconcile(input) {
      const saved = await retained(input, role), value = await engine(saved).receipt(input.operationId, 2)
      return { ...value, transactionHash: value.hash }
    },
    close: async () => {}
  })
  return { ...api(), role: name => {
    if (!roleCalls[name]) fail('BANK_OPERATOR_ROLE_DENIED')
    return api(name)
  }, testCityGrant:()=>{
    const donor=context({},TEST_CITY_GRANT)
    return{...api(TEST_CITY_GRANT),operationId:testCityGrantOperationId(manifest),
      async preflight(){
        await verify('city')
        const unresolved=await pool.query(`SELECT 1 FROM ${schema}.bank_operator_bindings b LEFT JOIN ${schema}.ac_chain_intents i USING(operation_id)
          WHERE b.binding->>'account'=$1 AND b.operation_id<>$2 AND (i.status IS NULL OR i.status NOT IN ('confirmed','reverted')) LIMIT 1`,[lower(donor.wallet.address),testCityGrantOperationId(manifest)])
        if(unresolved.rowCount)fail('BANK_TEST_CITY_GRANT_DONOR_PENDING_INTENT')
        const source=lower(donor.wallet.address),balance=await client.readContract({address:manifest.city,abi:abiByTarget.city,functionName:'balanceOf',args:[source]})
        const spenders=[...new Set(['bank','router','market','workEscrow'].map(key=>lower(manifest[key])))]
        const approvals=await Promise.all(spenders.map(spender=>client.readContract({address:manifest.city,abi:abiByTarget.city,functionName:'allowance',args:[source,spender]})))
        const reserved=approvals.reduce((sum,value)=>sum+BigInt(value),0n)
        if(BigInt(balance)-reserved<TEST_CITY_GRANT_AMOUNT)fail('BANK_TEST_CITY_GRANT_DONOR_FREE_BALANCE_REQUIRED')
        return{source,cityBalanceBaseUnits:String(balance),reservedAllowancesBaseUnits:String(reserved),freeBalanceBaseUnits:String(BigInt(balance)-reserved)}
      }}
  }, async testGameGrant(binding) {
    const pinned = Object.freeze({ ...binding, principalId: binding?.principalId?.toLowerCase(), recipient: binding?.recipient?.toLowerCase() })
    const operationIds = testGameGrantOperationIds(manifest, pinned)
    const role = { kind: TEST_GAME_GRANT, binding: pinned }, donor = context({}, role)
    async function verifyBinding() {
      const rows = (await pool.query(`SELECT w.*,a.principal_id AS alias_principal,a.address AS alias_address,a.provider_account_id AS alias_provider,
        p.privy_subject FROM ac_playable_testnet_wallets w JOIN ac_discord_wallet_aliases a USING(wallet_id)
        JOIN ac_discord_principals p ON p.principal_id=a.principal_id JOIN ac_discord_identities d ON d.principal_id=p.principal_id
        WHERE w.wallet_id=$1 AND a.principal_id=$2`, [pinned.walletId, pinned.principalId])).rows
      const row = rows[0]
      if (rows.length !== 1 || row.provider_type !== 'privy' || row.environment !== 'UNICHAIN_SEPOLIA_PLAYABLE' || !row.provider_account_id ||
          row.address?.toLowerCase() !== pinned.recipient || row.alias_address?.toLowerCase() !== pinned.recipient ||
          row.alias_provider !== row.provider_account_id || row.auth_subject_hash !== pinned.subjectHash || typeof row.privy_subject !== 'string' ||
          createHash('sha256').update(row.privy_subject).digest('hex') !== pinned.subjectHash || addresses.has(pinned.recipient)) fail('BANK_TEST_GAME_GRANT_VERIFIED_PRIVY_WALLET_REQUIRED')
    }
    await verifyBinding()
    return { address: donor.wallet.address, operationIds,
      async preflight() {
        await verifyBinding(); await verify('city')
        const unresolved = await pool.query(`SELECT 1 FROM ${schema}.bank_operator_bindings b LEFT JOIN ${schema}.ac_chain_intents i USING(operation_id)
          WHERE b.binding->>'account'=$1 AND b.operation_id<>ALL($2::uuid[]) AND (i.status IS NULL OR i.status NOT IN ('confirmed','reverted')) LIMIT 1`, [lower(donor.wallet.address), [operationIds.city, operationIds.native]])
        if (unresolved.rowCount) fail('BANK_TEST_GAME_GRANT_DONOR_PENDING_INTENT')
        const source = lower(donor.wallet.address), balance = await client.readContract({ address: manifest.city, abi: abiByTarget.city, functionName: 'balanceOf', args: [source] })
        const spenders = [...new Set(['bank', 'router', 'market', 'workEscrow'].map(key => lower(manifest[key])))]
        const allowances = await Promise.all(spenders.map(spender => client.readContract({ address: manifest.city, abi: abiByTarget.city, functionName: 'allowance', args: [source, spender] })))
        const reserved = allowances.reduce((sum, value) => sum + BigInt(value), 0n)
        const nativeBalance = await client.getBalance({ address: source })
        if (BigInt(balance) - reserved < TEST_GAME_CITY_AMOUNT) fail('BANK_TEST_GAME_GRANT_DONOR_FREE_CITY_REQUIRED')
        if (BigInt(nativeBalance) < TEST_GAME_NATIVE_AMOUNT + 2n * BigInt(manifest.maxNativeCostWei)) fail('BANK_TEST_GAME_GRANT_DONOR_NATIVE_REQUIRED')
        return { source, freeCityBaseUnits: String(BigInt(balance) - reserved), nativeBalanceWei: String(nativeBalance) }
      },
      async prepare(input) { await verifyBinding(); return prepare(input, role) },
      async broadcast(input) { await verifyBinding(); const saved = await retained(input, role); const value = await engine(saved).broadcast(input.operationId); return { ...value, transactionHash: value.hash } },
      async reconcile(input) { await verifyBinding(); const saved = await retained(input, role); const value = await engine(saved).receipt(input.operationId, 2); return { ...value, transactionHash: value.hash } }
    }
  }, settings, store, client, schema,
    disclosure: 'Operator-controlled test wallets; not Privy or independent human approval.',
    async balances(playerId) {
      const actor = actors.find(value => value.principalId === playerId)
      if (!actor) fail('BANK_OPERATOR_KNOWN_ACTOR_REQUIRED')
      return { address: actor.wallet.address, nativeWei: String(await client.getBalance({ address: actor.wallet.address })),
        tokens: Object.fromEntries(await Promise.all(['city', 'usdc', 'gem'].map(async name => [name,
          String(await client.readContract({ address: manifest[name], abi: abiByTarget[name], functionName: 'balanceOf', args: [actor.wallet.address] }))]))) }
    }
  }
}
