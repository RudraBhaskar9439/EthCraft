import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

// Read-only verification of the explicit local role-separated deployment.
const root = new URL('../', import.meta.url)
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { createPublicClient, http, decodeEventLog, keccak256, stringToHex } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n'
const load = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const candidate = process.argv[2] || 'contracts/local-deployment.json'
const output = process.argv[3] || 'evidence/runs/local-p5-p8-v2/anvil-deployment-verification.json'
const freshChain = process.argv[4] === '--fresh'
const deployment = await load(candidate)
assert.equal(deployment.environment, 'LOCAL_SYNTHETIC_ONLY')
assert.equal(deployment.chainId, 31337)
const url = new URL(deployment.rpcUrl || 'http://127.0.0.1:8547')
assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password)
const rpc = createPublicClient({ transport: http(url.toString(), { retryCount: 0, timeout: 5000 }) })
assert.equal(await rpc.getChainId(), 31337)
const equal = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase())
const roles = ['admin', 'warehouse', 'publisher', 'attestor', 'requester', 'builder', 'issuer']
assert.equal(new Set(roles.map(role => deployment[role].toLowerCase())).size, 7)
for (const [addressIndex, role] of roles.entries()) equal(deployment[role], mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }).address)
const artifacts = {}
const contracts = {}
for (const [field, name] of Object.entries({ creditToken: 'CreditToken', kitCustody: 'KitCustody', stateRegistry: 'StateRegistry', poolManager: 'PoolManager', hook: 'AgentCityHook', procurement: 'Procurement', jobEscrow: 'JobEscrow', liquidityRouter: 'PoolModifyLiquidityTest' })) {
  const artifact = await load(`contracts/out/${name}.sol/${name}.json`)
  artifacts[field] = artifact
  const code = await rpc.getCode({ address: deployment[field] })
  assert.ok(code && code !== '0x', `${field}: deployed code required`)
  const actual = Buffer.from(code.slice(2), 'hex')
  const expected = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex')
  const normalized = Buffer.from(actual)
  for (const references of Object.values(artifact.deployedBytecode.immutableReferences || {})) {
    for (const { start, length } of references) {
      normalized.fill(0, start, start + length)
      expected.fill(0, start, start + length)
    }
  }
  assert.deepEqual(normalized, expected, `${field}: compiled runtime mismatch`)
  contracts[field] = { address: deployment[field], bytecode_bytes: actual.length, bytecode_sha256: createHash('sha256').update(actual).digest('hex'), compiled_runtime_matches_except_checked_immutables: true }
}
const read = (field, functionName, args = [], blockNumber) => rpc.readContract({ address: deployment[field], abi: artifacts[field].abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) })
equal(await read('creditToken', 'owner'), deployment.admin)
equal(await read('creditToken', 'issuer'), deployment.issuer)
equal(await read('kitCustody', 'issuer'), deployment.issuer)
equal(await read('kitCustody', 'warehouse'), deployment.warehouse)
equal(await read('stateRegistry', 'publisher'), deployment.publisher)
equal(await read('jobEscrow', 'attestor'), deployment.attestor)
for (const field of ['procurement', 'jobEscrow']) {
  equal(await read(field, 'cred'), deployment.creditToken)
  equal(await read(field, 'kit'), deployment.kitCustody)
}
equal(await read('hook', 'registry'), deployment.stateRegistry)
equal(await read('hook', 'poolManager'), deployment.poolManager)
equal(await read('procurement', 'poolManager'), deployment.poolManager)
equal(await read('liquidityRouter', 'manager'), deployment.poolManager)
assert.equal(BigInt(deployment.hook) & ((1n << 14n) - 1n), 1n << 7n)
equal(await read('kitCustody', 'serverId'), deployment.serverId)
equal(await read('kitCustody', 'bundleHash'), deployment.bundleHash)
assert.equal(await read('kitCustody', 'backed'), true)
assert.equal(await read('kitCustody', 'totalSupply'), 1000n * 10n ** 18n)
assert.equal(await read('creditToken', 'totalSupply'), 11000n * 10n ** 18n)
const key = await read('procurement', 'key')
const currencies = [deployment.creditToken, deployment.kitCustody].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1)
equal(key[0], currencies[0]); equal(key[1], currencies[1]); equal(key[4], deployment.hook)
assert.equal(Number(key[2]), 3000); assert.equal(Number(key[3]), 60)
equal(await read('hook', 'currency0'), currencies[0]); equal(await read('hook', 'currency1'), currencies[1])
const simulate = (field, functionName, args, account) => rpc.simulateContract({ address: deployment[field], abi: artifacts[field].abi, functionName, args, account })
await assert.rejects(simulate('creditToken', 'mint', [deployment.requester, 1n], deployment.admin), /issuer/)
await assert.rejects(simulate('creditToken', 'transferOwnership', [deployment.issuer], deployment.admin), /separate issuer/)
await simulate('creditToken', 'mint', [deployment.requester, 1n], deployment.issuer)
const bill = [65n, 4n, 16n, 37n, 19n, 3n]
await assert.rejects(simulate('kitCustody', 'depositAndIssue', [keccak256(stringToHex('role-verification-only')), deployment.requester, 1n, bill], deployment.admin), /issuer/)
const broadcast = await load('contracts/broadcast/LocalDeploy.s.sol/31337/run-latest.json')
assert.equal(broadcast.receipts.length, 19)
const receipts = []
for (const receipt of broadcast.receipts) {
  const canonical = await rpc.getTransactionReceipt({ hash: receipt.transactionHash })
  assert.equal(canonical.status, 'success')
  assert.equal(canonical.blockHash, (await rpc.getBlock({ blockNumber: canonical.blockNumber })).hash)
  receipts.push(canonical)
}
const liquidityReceipts = receipts.filter(receipt => receipt.logs.some(log => log.address.toLowerCase() === deployment.poolManager.toLowerCase() && (() => {
  try { return decodeEventLog({ abi: artifacts.poolManager.abi, ...log }).eventName === 'ModifyLiquidity' } catch { return false }
})()))
assert.equal(liquidityReceipts.length, 1)
const liquidityReceipt = liquidityReceipts[0]
const liquidityEvent = liquidityReceipt.logs.flatMap(log => {
  try { return [decodeEventLog({ abi: artifacts.poolManager.abi, ...log })] } catch { return [] }
}).find(event => event.eventName === 'ModifyLiquidity').args
assert.equal(liquidityEvent.liquidityDelta, 100n * 10n ** 18n)
assert.equal(liquidityEvent.tickLower, -600); assert.equal(liquidityEvent.tickUpper, 600)
equal(liquidityEvent.sender, deployment.liquidityRouter)
const seedAmounts = {}
for (const field of ['creditToken', 'kitCustody']) {
  const before = await read(field, 'balanceOf', [deployment.admin], liquidityReceipt.blockNumber - 1n)
  const after = await read(field, 'balanceOf', [deployment.admin], liquidityReceipt.blockNumber)
  seedAmounts[field] = { adminBefore: before, adminAfter: after, amount: before - after }
}
const previous = freshChain ? { contracts: {} } : await load('evidence/runs/local-p5-p8/anvil-deployment-verification.json')
for (const expected of Object.values(previous.contracts)) {
  const code = await rpc.getCode({ address: expected.address })
  assert.equal(createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex'), expected.bytecode_sha256, 'previous deployed contracts must remain intact')
}
const report = { status: 'pass', deploymentVersion: 2, scope: 'Actual local Anvil deployment with distinct administrator, issuer, warehouse, publisher, attestor, requester and builder; synthetic inventory only', recorded_at: new Date().toISOString(), chainId: 31337, genesisHash: (await rpc.getBlock({ blockNumber: 0n })).hash, block: await rpc.getBlockNumber({ cacheTime: 0 }), rpcUrl: url.toString(), contracts, hook_permissions_beforeSwap_only: true, roles: Object.fromEntries(roles.map(role => [role, deployment[role]])), role_checks: { seven_distinct_public_fixture_roles: true, cred_admin_cannot_mint: true, cred_issuer_can_mint_simulation_only: true, kit_admin_cannot_issue: true, admin_cannot_transfer_ownership_to_issuer: true, previous_deployed_contract_bytecodes_unchanged: true }, seed: { event: liquidityEvent, transactionHash: liquidityReceipt.transactionHash, tokenAmounts: seedAmounts }, receipts }
report.freshChain = freshChain
report.role_checks.previous_deployed_contract_bytecodes_unchanged = freshChain ? null : true
const destination = new URL(output, root)
await mkdir(new URL('./', destination), { recursive: true })
await writeFile(destination, json(report), { flag: 'wx' })
console.log(json({ status: 'pass', checks: report.role_checks, transactions: receipts.length, evidence: destination.pathname }).trim())
