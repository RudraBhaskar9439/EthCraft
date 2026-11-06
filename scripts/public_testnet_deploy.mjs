import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { openTestnetRuntime } from '../backend/src/chain/testnet-runtime.mjs'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, keccak256, stringToHex, getCreate2Address, toHex } = require('viem')
const root = new URL('../', import.meta.url)
const directory = new URL('.local/public-testnet/', root)
await mkdir(directory, { recursive: true, mode: 0o700 })
const progressFile = new URL('deployment-progress.json', directory)
const { acquireLocalLease } = require('./src/bot/checkpoint-store.cjs')
const release = await acquireLocalLease('agentcity-public-testnet-deployment-1301')
let runtime
try {
  let progress
  try { progress = JSON.parse(await readFile(progressFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; progress = { runId: randomUUID(), operations: {} } }
  const save = async () => { await writeFile(new URL('deployment-progress.tmp', directory), JSON.stringify(progress, null, 2) + '\n', { mode: 0o600 }); await rename(new URL('deployment-progress.tmp', directory), progressFile) }
  runtime = await openTestnetRuntime()
  const { evm, accounts } = runtime
  const { admin, warehouse, publisher, attestor, requester, builder, issuer } = accounts
  const artifact = async name => JSON.parse(await readFile(new URL(`contracts/out/${name}.sol/${name}.json`, root), 'utf8'))
  try {
    const upstream = JSON.parse(await readFile(new URL('official-uniswap-deployments.json', directory), 'utf8'))
    const official = {}
    for (const name of ['PoolManager', 'PositionManager', 'Permit2']) {
      const record = upstream.records.find(record => record.chainId === 1301 && record.contract === name && record.env === 'testnet' && record.status === 'active')
      assert.ok(record)
      const code = await evm.client.getCode({ address: record.address })
      assert.ok(code && code !== '0x', 'Official deployed contract must have code')
      official[name] = { address: record.address, codeHash: keccak256(code), sourceRef: record.sourceRef }
    }
    async function send(name, account, to, data, value = 0n) {
      if (!progress.operations[name]) { progress.operations[name] = { id: randomUUID() }; await save() }
      const operation = progress.operations[name]
      await evm.prepare(operation.id, account, to, data, value)
      await evm.broadcast(operation.id)
      const result = await evm.receipt(operation.id)
      assert.equal(result.status, 'confirmed', name + ' must confirm')
      operation.hash = result.hash
      operation.blockNumber = result.receipt.blockNumber.toString()
      operation.gasUsed = result.receipt.gasUsed.toString()
      await save()
      console.log('Confirmed ' + name + ': ' + result.hash)
      return result.receipt
    }
    const deploy = async (name, args) => {
      const compiled = await artifact(name)
      const result = await send('deploy-' + name, admin, null, encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }))
      assert.ok(result.contractAddress)
      return result.contractAddress
    }
    const call = async (name, account, address, contract, method, args) => send(name, account, address, encodeFunctionData({ abi: (await artifact(contract)).abi, functionName: method, args }))
    for (const [role, account] of Object.entries(accounts)) {
      if (role === 'admin') continue
      await send('fund-role-' + role, admin, account.address, '0x', 150000000000000n)
    }
    const bill = [65n, 4n, 16n, 37n, 19n, 3n]
    const serverId = keccak256(stringToHex('agentcity-separate-contract-demo-1301'))
    const bundleHash = keccak256(encodeAbiParameters([{ type: 'uint256[6]' }], [bill]))
    const creditToken = await deploy('CreditToken', [admin.address, issuer.address])
    const kitCustody = await deploy('KitCustody', [issuer.address, warehouse.address, serverId, bundleHash, bill])
    const stateRegistry = await deploy('StateRegistry', [publisher.address, keccak256(stringToHex('agentcity-demo-cred-kit-1301'))])
    const factory = await deploy('DemoHookFactory', [])
    const poolManager = official.PoolManager.address
    const hookArtifact = await artifact('AgentCityHook')
    const code = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode.object, args: [poolManager, stateRegistry, creditToken, kitCustody] })
    let salt, hook
    for (let nonce = 0; ; nonce++) {
      salt = toHex(nonce, { size: 32 })
      hook = getCreate2Address({ from: factory, salt, bytecodeHash: keccak256(code) })
      if ((BigInt(hook) & 0x3fffn) === 0x80n) break
    }
    await call('deploy-hook', admin, factory, 'DemoHookFactory', 'deploy', [salt, code])
    const currencies = [creditToken, kitCustody].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)
    const poolKey = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60, hooks: hook }
    await call('initialize-pool', admin, poolManager, 'PoolManager', 'initialize', [poolKey, 2n ** 96n])
    const procurement = await deploy('Procurement', [poolManager, creditToken, kitCustody, poolKey])
    const jobEscrow = await deploy('JobEscrow', [creditToken, kitCustody, attestor.address])
    await call('mint-admin-demo-credit', issuer, creditToken, 'CreditToken', 'mint', [admin.address, 10000n * 10n ** 18n])
    await call('mint-requester-demo-credit', issuer, creditToken, 'CreditToken', 'mint', [requester.address, 1000n * 10n ** 18n])
    await call('issue-synthetic-kits', issuer, kitCustody, 'KitCustody', 'depositAndIssue', [keccak256(stringToHex(progress.runId + '-synthetic-only-stock')), admin.address, 1000n, bill.map(amount => amount * 1000n)])
    const allowance = 100n * 10n ** 18n
    const permitAbi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)'])
    const positionAbi = parseAbi(['function modifyLiquidities(bytes unlockData,uint256 deadline) payable'])
    if (!progress.permitExpiry) { progress.permitExpiry = ((await evm.client.getBlock()).timestamp + 3600n).toString(); await save() }
    for (const token of [creditToken, kitCustody]) {
      await call('approve-permit2-' + token, admin, token, 'CreditToken', 'approve', [official.Permit2.address, allowance])
      const expiry = BigInt(progress.permitExpiry)
      await send('approve-position-' + token, admin, official.Permit2.address, encodeFunctionData({ abi: permitAbi, functionName: 'approve', args: [token, official.PositionManager.address, allowance, Number(expiry)] }))
    }
    const mint = encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes'), [poolKey, -600, 600, 1000n * 10n ** 18n, allowance, allowance, admin.address, '0x'])
    const settle = encodeAbiParameters(parseAbiParameters('address,address'), currencies)
    const unlock = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x020d', [mint, settle]])
    const seedId = progress.operations['seed-position']?.id
    const seedIntent = seedId && (await runtime.store.query('SELECT status FROM ac_chain_intents WHERE operation_id=$1', [seedId])).rows[0]
    const seedNow = (await evm.client.getBlock()).timestamp
    if (!progress.positionDeadline || !seedIntent && BigInt(progress.positionDeadline) <= seedNow) { progress.positionDeadline = (seedNow + 300n).toString(); await save() }
    if (seedIntent?.status === 'reverted') throw new Error('seed_reverted_requires_separately_recorded_retry')
    await send('seed-position', admin, official.PositionManager.address, encodeFunctionData({ abi: positionAbi, functionName: 'modifyLiquidities', args: [unlock, BigInt(progress.positionDeadline)] }))
    for (const [name, target] of [['procurement', procurement], ['escrow', jobEscrow]]) await call('approve-requester-' + name, requester, creditToken, 'CreditToken', 'approve', [target, 1000n * 10n ** 18n])
    const deployment = { chainId: 1301, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', rpcUrl: evm.rpcUrl, genesisHash: evm.genesisHash,
      ...Object.fromEntries(Object.entries(accounts).map(([role, account]) => [role, account.address])),
      creditToken, kitCustody, stateRegistry, poolManager, hook, procurement, jobEscrow, positionManager: official.PositionManager.address,
      serverId, bundleHash, poolKey, official, scope: 'Separate synthetic contract demonstration; no token effects in Minecraft', confirmations: 2 }
    await writeFile(new URL('deployment.json', directory), JSON.stringify(deployment, null, 2) + '\n')
    const output = new URL(`evidence/runs/public-testnet-deployment/${progress.runId}/`, root)
    await mkdir(output, { recursive: true })
    await writeFile(new URL('report.json', output), JSON.stringify({ status: 'pass', deployment, operations: progress.operations, realMoneySpentUsd: 0, independentHumans: 0 }, null, 2) + '\n')
    console.log('Public-testnet deployment verified: ' + output.pathname)
  } finally { if (runtime) await runtime.close() }
} finally { await release() }
