import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, http, parseAbi, encodeAbiParameters, parseAbiParameters, keccak256 } = require('viem')
const { writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const manifest = JSON.parse(await readFile(join(root, '.local/marketplace/public-deployment.json'), 'utf8'))
const oldBytes = await readFile(join(root, '.local/bank/public-deployment.json')), old = JSON.parse(oldBytes)
const settings = JSON.parse(await readFile(join(root, '.local/bank/operator-settings.json'), 'utf8'))
const client = createPublicClient({ transport: http(manifest.rpcUrl, { retryCount: 0, timeout: 15000 }) })
const evidence = join(root, 'evidence/runs/marketplace-deployment-verification', randomUUID())
await mkdir(evidence, { recursive: true })
const report = { status: 'running', schema: 'agentcity.marketplace-deployment-check.v1', checks: [],
  deploymentId: manifest.deploymentId, publicTransactions: 0, walletSignatures: 0, newLendingTransactions: 0 }
const check = async (name, run) => { await run(); report.checks.push({ name, status: 'pass' }) }
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase())
try {
  await check('Marketplace mode and inherited custody/journal identities', async () => {
    assert.equal(manifest.mode, 'marketplace'); assert.equal(manifest.schema, 'agentcity.bank.v1')
    assert.equal(manifest.journalSchema, old.journalSchema); assert.deepEqual(manifest.worldAssets, old.worldAssets)
    assert.equal(createHash('sha256').update(oldBytes).digest('hex'), manifest.historicalDeployment.manifestSha256)
    assert.equal(await client.getChainId(), 1301); same((await client.getBlock({ blockNumber: 0n })).hash, manifest.genesisHash)
    assert.notEqual(manifest.hook.toLowerCase(), old.hook.toLowerCase()); assert.notEqual(manifest.router, old.router)
    assert.equal(manifest.marketplace.activeCreditFeatures, false)
    assert.deepEqual(manifest.marketplace.supportedActiveTokens, ['USDC', 'CITY'])
  })
  await check('Pinned deployed code and exact source files', async () => {
    for (const [name, expected] of Object.entries(manifest.codeHashes)) same(keccak256(await client.getCode({ address: manifest[name] })), expected)
    for (const [path, expected] of Object.entries(manifest.sourceHashes)) assert.equal(createHash('sha256').update(await readFile(join(root, path))).digest('hex'), expected)
    assert.equal(Number(BigInt(manifest.hook) & 0x3fffn), 0x1fc0)
  })
  await check('Hook/router/official quoter and pair bindings without a credit interface', async () => {
    for (const [address, name, expected] of [[manifest.hook, 'router', manifest.router], [manifest.hook, 'city', manifest.city],
      [manifest.hook, 'usdc', manifest.usdc], [manifest.hook, 'quoter', manifest.quoter], [manifest.hook, 'registry', manifest.stateRegistry],
      [manifest.router, 'hook', manifest.hook], [manifest.router, 'poolManager', manifest.poolManager], [manifest.router, 'market', manifest.market]]) {
      same(await client.readContract({ address, abi: parseAbi(['function ' + name + '() view returns(address)']), functionName: name }), expected)
    }
    const artifact = JSON.parse(await readFile(join(root, 'contracts/out/AgentCityMarketplaceHook.sol/AgentCityMarketplaceHook.json'), 'utf8'))
    assert(!artifact.abi.some(value => value.type === 'function' && ['bank', 'history', 'creditScore'].includes(value.name)))
  })
  await check('Mature real reference and payer-independent market fee', async () => {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
    const abi = parseAbi(['function marketReference() view returns(bool ready,int24 meanTick,uint64 anchorTimestamp,uint64 age)', 'function feeFor(address) view returns(uint24)'])
    const reference = await client.readContract({ address: manifest.hook, abi, functionName: 'marketReference', blockNumber })
    assert.equal(reference[0], true); assert(Number(reference[3]) >= 300 && Number(reference[3]) <= 600)
    const fees = await Promise.all(['borrower', 'bidder'].map(role => client.readContract({ address: manifest.hook, abi, functionName: 'feeFor',
      args: [settings.actors[role].wallet.address], blockNumber })))
    assert.equal(fees[0], fees[1]); assert(Number(fees[0]) >= 3000 && Number(fees[0]) <= 10000)
    report.reference = reference.map(value => typeof value === 'bigint' ? String(value) : value); report.feePips = Number(fees[0])
  })
  await check('Official LP position and historical positions retain liquidity and ownership', async () => {
    const abi = parseAbi(['function ownerOf(uint256) view returns(address)', 'function getPositionLiquidity(uint256) view returns(uint128)'])
    for (const value of [manifest.marketplace.initialLiquidity, ...Object.values(old.liquidity)]) {
      same(await client.readContract({ address: manifest.positionManager, abi, functionName: 'ownerOf', args: [BigInt(value.positionId)] }), manifest.roles.liquidity)
      assert.equal(String(await client.readContract({ address: manifest.positionManager, abi, functionName: 'getPositionLiquidity', args: [BigInt(value.positionId)] })), value.liquidity)
    }
  })
  await check('Actual official whole-token exit quote uses correct6/18units', async () => {
    const key = manifest.pools.cityUsdc
    const value = await client.simulateContract({ address: manifest.quoter,
      abi: parseAbi(['function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256 amountIn,uint256 gasEstimate)']),
      functionName: 'quoteExactOutputSingle', args: [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === manifest.city,
        exactAmount: 1000000n, hookData: encodeAbiParameters(parseAbiParameters('address'), [settings.actors.borrower.wallet.address]) }] })
    assert(value.result[0] > 900000000000000000n && value.result[0] < 1100000000000000000n)
    report.exitQuote = { cityInputBaseUnits: String(value.result[0]), mockUsdcOutputBaseUnits: '1000000' }
  })
  report.status = 'pass'
} catch (error) { report.status = 'fail'; report.error = { name: error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }; process.exitCode = 1 }
finally {
  await writeCheckpoint(join(evidence, 'report.json'), report)
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence, error: report.error }))
}
