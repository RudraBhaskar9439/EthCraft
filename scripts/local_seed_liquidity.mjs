import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { PostgresStore } from '../backend/src/storage/postgres.mjs'
import { LocalEvm } from '../backend/src/chain/local-evm.mjs'

// Explicit local operator setup. Purchase paths never invoke this helper.
const root = new URL('../', import.meta.url)
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, encodeFunctionData, encodeAbiParameters, keccak256, decodeEventLog, maxUint256, zeroHash } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const load = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n'
const equalAddress = (left, right) => left.toLowerCase() === right.toLowerCase()
const pointerPath = new URL('.local/backend/liquidity-seed.json', root)
const deployment = await load('contracts/local-deployment.json')
assert.equal(deployment.environment, 'LOCAL_SYNTHETIC_ONLY')
assert.equal(deployment.chainId, 31337)
assert.match(deployment.poolManager, /^0x[0-9a-fA-F]{40}$/)
const output = new URL(`evidence/runs/local-p6-liquidity/${deployment.poolManager.toLowerCase()}/`, root)
const rpcUrl = new URL(deployment.rpcUrl)
assert.ok(rpcUrl.protocol === 'http:' && rpcUrl.hostname === '127.0.0.1' && !rpcUrl.username && !rpcUrl.password, 'loopback_rpc_required')
const admin = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 0 })
assert.ok(equalAddress(admin.address, deployment.admin), 'public_anvil_admin_required')
const rpc = createPublicClient({ transport: http(rpcUrl.toString(), { retryCount: 0, timeout: 5000 }) })
assert.equal(await rpc.getChainId(), 31337)
const genesisHash = (await rpc.getBlock({ blockNumber: 0n })).hash
const environment = await load('.local/backend/environment.json')
const databaseUrl = new URL(environment.databaseUrl)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'local_database_required')
databaseUrl.searchParams.set('options', '-c search_path=public')
const store = new PostgresStore(databaseUrl.toString())
const evm = new LocalEvm({ store, rpcUrl: rpcUrl.toString(), genesisHash })
const routerAbi = (await load('contracts/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json')).abi
  .filter(item => item.name !== 'modifyLiquidity' || item.inputs.length === 3)
const managerAbi = (await load('contracts/out/PoolManager.sol/PoolManager.json')).abi
const procurementAbi = await load('contracts/abi/Procurement.json')
const tokenAbi = await load('contracts/abi/CreditToken.json')
const params = { tickLower: -600, tickUpper: 600, liquidityDelta: 1000n * 10n ** 18n, salt: zeroHash }
let pointer
let lock
const savePointer = async () => {
  const temporary = new URL(`.local/backend/liquidity-seed.${randomUUID()}.tmp`, root)
  await writeFile(temporary, json(pointer), { mode: 0o600, flag: 'wx' })
  await rename(temporary, pointerPath)
  await chmod(pointerPath, 0o600)
}

try {
  await evm.verify()
  await store.migrate([new URL('backend/src/chain/schema.sql', root)])
  lock = await store.pool.connect()
  await lock.query("SELECT pg_advisory_lock(hashtextextended('agentcity-local-liquidity-seed',0))")
  const read = (address, abi, functionName, args = [], blockNumber) => rpc.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) })
  assert.ok(equalAddress(await read(deployment.liquidityRouter, routerAbi, 'manager'), deployment.poolManager), 'router_manager_mismatch')
  const route = await read(deployment.procurement, procurementAbi, 'key')
  const currencies = [deployment.creditToken, deployment.kitCustody].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1)
  const key = { currency0: route[0], currency1: route[1], fee: Number(route[2]), tickSpacing: Number(route[3]), hooks: route[4] }
  assert.ok(equalAddress(key.currency0, currencies[0]) && equalAddress(key.currency1, currencies[1]), 'fixed_currencies_required')
  assert.equal(key.fee, 3000)
  assert.equal(key.tickSpacing, 60)
  assert.ok(equalAddress(key.hooks, deployment.hook), 'fixed_hook_required')
  const calldata = encodeFunctionData({ abi: routerAbi, functionName: 'modifyLiquidity', args: [key, params, '0x'] })
  const binding = {
    environment: 'LOCAL_SYNTHETIC_ONLY', chainInstance: evm.instance, admin: admin.address,
    router: deployment.liquidityRouter, poolManager: deployment.poolManager, key, params, calldata,
  }
  const digest = createHash('sha256').update(json(binding)).digest('hex')
  const operationId = label => {
    const hash = createHash('sha256').update(`${digest}:${label}`).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  }
  const operations = Object.fromEntries(['credApproval', 'kitApproval', 'seed'].map(label => [label, operationId(label)]))
  await mkdir(new URL('.local/backend/', root), { recursive: true, mode: 0o700 })
  try { pointer = await load('.local/backend/liquidity-seed.json') } catch (error) {
    if (error.code !== 'ENOENT') throw error
    pointer = { version: 1, bindingDigest: digest, binding, createdAt: new Date().toISOString(), status: 'created', operations }
    await writeFile(pointerPath, json(pointer), { mode: 0o600, flag: 'wx' })
  }
  assert.equal(pointer.bindingDigest, digest, 'seed_binding_conflict')
  assert.equal(createHash('sha256').update(json(pointer.binding)).digest('hex'), digest, 'seed_pointer_changed')
  assert.deepEqual(pointer.operations, operations, 'seed_operation_ids_changed')
  await chmod(pointerPath, 0o600)
  const transact = async (operationId, destination, data) => {
    await evm.prepare(operationId, admin, destination, data)
    let result = await evm.receipt(operationId)
    if (result.status === 'pending' || result.status === 'confirming') {
      const sent = await evm.broadcast(operationId)
      pointer.status = sent.status
      await savePointer()
      assert.equal(sent.status, 'submitted', 'original_intent_requires_reconciliation')
      result = await evm.receipt(operationId)
    }
    assert.equal(result.status, 'confirmed', 'canonical_success_required_no_replacement_intent')
    return result
  }
  const { rows: [existing] } = await store.query('SELECT * FROM public.ac_chain_intents WHERE operation_id=$1', [pointer.operations.seed])
  if (!existing) {
    for (const [token, operation] of [[deployment.creditToken, pointer.operations.credApproval], [deployment.kitCustody, pointer.operations.kitApproval]]) {
      if (await read(token, tokenAbi, 'allowance', [admin.address, deployment.liquidityRouter]) < maxUint256 / 2n) {
        await transact(operation, token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [deployment.liquidityRouter, maxUint256] }))
      }
    }
    await rpc.simulateContract({ address: deployment.liquidityRouter, abi: routerAbi, functionName: 'modifyLiquidity', args: [key, params, '0x'], account: admin })
  }
  const replay = Boolean(existing && (await evm.receipt(pointer.operations.seed)).status === 'confirmed')
  const headBefore = await rpc.getBlockNumber({ cacheTime: 0 })
  const nonceBefore = await rpc.getTransactionCount({ address: admin.address, blockTag: 'pending' })
  const result = await transact(pointer.operations.seed, deployment.liquidityRouter, calldata)
  const transaction = await rpc.getTransaction({ hash: result.hash })
  assert.ok(equalAddress(transaction.from, admin.address) && equalAddress(transaction.to, deployment.liquidityRouter))
  assert.equal(transaction.input, calldata)
  assert.equal(transaction.value, 0n)
  const block = await rpc.getBlock({ blockNumber: result.receipt.blockNumber })
  assert.deepEqual(block.transactions, [result.hash], 'isolated_anvil_transaction_block_required')
  const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], Object.values(key)))
  const events = result.receipt.logs.filter(log => equalAddress(log.address, deployment.poolManager)).flatMap(log => {
    try { return [decodeEventLog({ abi: managerAbi, ...log })] } catch { return [] }
  }).filter(event => event.eventName === 'ModifyLiquidity')
  assert.equal(events.length, 1)
  const event = events[0].args
  assert.equal(event.id, poolId)
  assert.ok(equalAddress(event.sender, deployment.liquidityRouter))
  for (const field of ['tickLower', 'tickUpper', 'liquidityDelta', 'salt']) assert.equal(event[field], params[field])
  const tokenAmounts = {}
  for (const [name, token] of [['CRED', deployment.creditToken], ['KIT', deployment.kitCustody]]) {
    const before = await read(token, tokenAbi, 'balanceOf', [admin.address], result.receipt.blockNumber - 1n)
    const after = await read(token, tokenAbi, 'balanceOf', [admin.address], result.receipt.blockNumber)
    const supplyBefore = await read(token, tokenAbi, 'totalSupply', [], result.receipt.blockNumber - 1n)
    const supplyAfter = await read(token, tokenAbi, 'totalSupply', [], result.receipt.blockNumber)
    assert.ok(before > after, 'positive_existing_token_contribution_required')
    assert.equal(supplyBefore, supplyAfter, 'no_token_minting_permitted')
    tokenAmounts[name] = { token, decimals: 18, adminBefore: before, adminAfter: after, adminNetTokenSpend: before - after, supplyBefore, supplyAfter }
  }
  const report = { status: 'pass', environment: 'LOCAL_SYNTHETIC_ONLY', realSpendUsd: 0, purpose: 'Explicit additional synthetic operator liquidity for local console demonstrations', bindingDigest: digest, binding, poolId, operationId: pointer.operations.seed, transactionHash: result.hash, blockNumber: result.receipt.blockNumber, blockHash: result.receipt.blockHash, event, tokenAmounts, receipt: result.receipt, verifiedAt: new Date().toISOString() }
  await mkdir(output, { recursive: true })
  const evidencePath = new URL('seed.json', output)
  // Preserve the original successful seed record; replay gets a separate report.
  try { await writeFile(evidencePath, json(report), { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  pointer.status = 'confirmed'
  pointer.transactionHash = result.hash
  pointer.evidence = evidencePath.pathname
  await savePointer()
  if (replay) {
    const headAfter = await rpc.getBlockNumber({ cacheTime: 0 })
    const nonceAfter = await rpc.getTransactionCount({ address: admin.address, blockTag: 'pending' })
    assert.equal(headAfter, headBefore, 'replay_must_not_mine_a_transaction')
    assert.equal(nonceAfter, nonceBefore, 'replay_must_not_use_a_new_nonce')
    try {
      await writeFile(new URL('replay.json', output), json({ status: 'pass', check: 'same operation and canonical transaction; no second liquidity transaction', operationId: pointer.operations.seed, transactionHash: result.hash, blockNumber: result.receipt.blockNumber, headBefore, headAfter, nonceBefore, nonceAfter, verifiedAt: new Date().toISOString() }), { flag: 'wx' })
    } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  console.log(json({ status: 'pass', replay, transactionHash: result.hash, tokenAmounts, evidence: evidencePath.pathname }).trim())
} finally {
  if (lock) {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended('agentcity-local-liquidity-seed',0))")
    lock.release()
  }
  await store.close()
}
