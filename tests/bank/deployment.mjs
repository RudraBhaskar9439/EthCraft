// Read actual deployed bytecode, bindings and decimal-aware official v4 quotes.
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
const publicRun = process.argv.includes('--public')
assert(process.argv.slice(2).every(value => value === '--public'), 'Use no arguments for local verification, or --public for read-only testnet verification')
const manifestPath = join(root, '.local/bank', publicRun ? 'public-deployment.json' : 'local-deployment.json')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
const settings = JSON.parse(await readFile(join(root, '.local/bank/operator-settings.json'), 'utf8'))
const client = createPublicClient({ transport: http(manifest.rpcUrl, { retryCount: 0, timeout: 15000 }) })
const runId = randomUUID(), checks = []
const evidence = join(root, 'evidence/runs/bank-deployment-verification', runId)
await mkdir(evidence, { recursive: true })
const check = async (name, run) => { await run(); checks.push({ name, status: 'pass' }) }
const getAddress = (address, name) => client.readContract({ address, abi: parseAbi(['function ' + name + '() view returns(address)']), functionName: name })
const same = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase())
const report = { schema: 'agentcity.bank-deployment-verification.v1', runId, chainId: manifest.chainId,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), publicTransactions: 0,
  walletSignatures: 0, nativeItemsRegistered: 0, independentHumans: 0, realMoneySpentUsd: 0, checks }
try {
  await check('Pinned chain and genesis', async () => {
    assert.equal(manifest.schema, 'agentcity.bank.v1')
    assert.equal(await client.getChainId(), manifest.chainId)
    same((await client.getBlock({ blockNumber: 0n })).hash, manifest.genesisHash)
    assert.equal(manifest.operatorControlled, true)
    assert.equal(manifest.mockUSDC, true)
  })
  await check('All manifest runtime code hashes', async () => {
    for (const [name, expected] of Object.entries(manifest.codeHashes)) {
      const code = await client.getCode({ address: manifest[name] })
      assert(code && code !== '0x', name + ' code')
      same(keccak256(code), expected)
    }
  })
  await check('Bank, marketplace, authenticated router and publisher bindings', async () => {
    for (const [contract, name, expected] of [[manifest.bank, 'registry', manifest.registry], [manifest.bank, 'usdc', manifest.usdc],
      [manifest.bank, 'lender', manifest.roles.lender], [manifest.market, 'registry', manifest.registry], [manifest.market, 'city', manifest.city],
      [manifest.router, 'poolManager', manifest.poolManager], [manifest.router, 'hook', manifest.hook], [manifest.hook, 'router', manifest.router],
      [manifest.hook, 'quoter', manifest.quoter], [manifest.hook, 'bank', manifest.bank], [manifest.hook, 'city', manifest.city],
      [manifest.stateRegistry, 'publisher', manifest.roles.publisher], [manifest.workEscrow, 'inspector', manifest.roles.inspector]]) {
      same(await getAddress(contract, name), expected)
    }
    assert(new Set(Object.values(manifest.roles).map(value => value.toLowerCase())).size === Object.keys(manifest.roles).length)
  })
  await check('Mock USDC6 and CITY/GEM18 identities', async () => {
    const abi = parseAbi(['function decimals() view returns(uint8)', 'function symbol() view returns(string)'])
    for (const [address, symbol, decimals] of [[manifest.usdc, 'tUSDC', 6], [manifest.city, 'CITY', 18], [manifest.gem, 'GEM', 18]]) {
      assert.equal(await client.readContract({ address, abi, functionName: 'symbol' }), symbol)
      assert.equal(await client.readContract({ address, abi, functionName: 'decimals' }), decimals)
    }
  })
  await check('Official quotes reflect18/6decimal seed price without requiring native health for exits', async () => {
    const abi = parseAbi(['function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256 amountIn,uint256 gasEstimate)'])
    const quotes = {}
    for (const [name, token, key] of [['CITY', manifest.city, manifest.pools.cityUsdc], ['GEM', manifest.gem, manifest.pools.gemUsdc]]) {
      const value = await client.simulateContract({ address: manifest.quoter, abi, functionName: 'quoteExactOutputSingle', args: [{ poolKey: key,
        zeroForOne: key.currency0.toLowerCase() === token.toLowerCase(), exactAmount: 1_000_000n,
        hookData: encodeAbiParameters(parseAbiParameters('address'), [settings.actors.borrower.wallet.address]) }] })
      const input = value.result[0]
      assert(input > 900_000_000_000_000_000n && input < 1_100_000_000_000_000_000n, name + ' quote uses whole tokens, not raw1:1 units')
      quotes[name] = { amountInBaseUnits: String(input), outputMockUsdcBaseUnits: '1000000' }
    }
    report.quotes = quotes
  })
  if (publicRun) await check('Actual official PositionManager LP ownership and funded token deposits', async () => {
    const abi = parseAbi(['function ownerOf(uint256) view returns(address)'])
    for (const value of Object.values(manifest.liquidity)) {
      same(await client.readContract({ address: manifest.positionManager, abi, functionName: 'ownerOf', args: [BigInt(value.positionId)] }), manifest.roles.liquidity)
      assert(Object.values(value.deposited).every(amount => BigInt(amount) > 0n))
      const receipt = await client.getTransactionReceipt({ hash: value.transactionHash })
      assert.equal(receipt.status, 'success')
      same(receipt.blockHash, (await client.getBlock({ blockNumber: receipt.blockNumber })).hash)
    }
  })
  if (publicRun) await check('Bootstrap native cost includes all chain fees and remains within its test ETH budget', async () => {
    const progress = JSON.parse(await readFile(join(root, '.local/bank/public-deployment-progress.json'), 'utf8'))
    assert.equal(progress.runId, manifest.deploymentRunId)
    const blocks = Object.values(progress.operations).map(value => BigInt(value.blockNumber))
    const first = blocks.reduce((a, b) => a < b ? a : b) - 1n
    const last = blocks.reduce((a, b) => a > b ? a : b)
    const wallets = [...new Set([...Object.values(settings.roles).map(value => value.address.toLowerCase()),
      ...Object.values(settings.actors).map(value => value.wallet.address.toLowerCase())])]
    const totals = await Promise.all([first, last].map(async blockNumber => {
      const balances = await Promise.all(wallets.map(address => client.getBalance({ address, blockNumber })))
      return balances.reduce((sum, value) => sum + value, 0n)
    }))
    assert(totals[0] >= totals[1], 'Closed bootstrap wallet set cannot invent native funds')
    const cost = totals[0] - totals[1]
    assert(cost <= BigInt(manifest.maximumNativeBudgetWei), 'Aggregate actual native cost exceeds its testnet budget')
    report.nativeFeeAccounting = { fromBlock: String(first), throughBlock: String(last), walletCount: wallets.length,
      actualTotalNativeCostWei: String(cost), maximumNativeBudgetWei: manifest.maximumNativeBudgetWei,
      method: 'Aggregate historical balances before/after bootstrap; internal funding cancels and chain data fees remain included.' }
  })
  report.status = 'pass'
} catch (error) {
  report.status = 'fail'; report.error = { name: error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }
  throw error
} finally {
  await writeCheckpoint(join(evidence, 'report.json'), report)
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence, publicTransactions: 0 }))
}
