// Real isolated PostgreSQL and a private fork of the owned local bank chain.
// Native custody and inspection are explicitly labelled fixtures, not Minecraft proof.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import pg from '../../backend/node_modules/pg/lib/index.js'
import { createBankService } from '../../backend/src/bank/service.mjs'
import { loadBankAbis } from '../../backend/src/bank/abis.mjs'
import { createWorldAssetStore } from '../../backend/src/world-assets/store.mjs'
import { DurableEvm } from '../../backend/src/chain/durable-evm.mjs'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { openDevelopmentKeystore } from '../../backend/src/chain/development-wallets.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, createWalletClient, http, keccak256, stringToHex, parseEventLogs, decodeFunctionData } = require('viem')
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts')
const { foundry } = require('viem/chains')
const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID(), schema = 'bank_test_' + runId.replaceAll('-', '')
const directory = join(root, 'evidence/runs/bank-service', runId)
await mkdir(directory, { recursive: true })
const report = { status: 'fail', runId, schema, publicTransactions: 0, paidModelCalls: 0, realMoneySpentUsd: 0, independentHumans: 0,
  scope: 'Actual isolated PostgreSQL/Anvil fork and official v4 contracts; synthetic native custody and inspector context; controlled signers.', checks: [] }
const check = name => { report.checks.push({ name, status: 'pass' }); console.log(JSON.stringify({ check: name, status: 'pass' })) }
let fork, pool, administrator, schemaCreated = false
try {
  const original = JSON.parse(await readFile(join(root, '.local/bank/local-deployment.json'), 'utf8'))
  assert.equal(original.environment, 'LOCAL_TEST_FIXTURE'); assert.equal(original.rpcUrl, 'http://127.0.0.1:8561')
  const rpcUrl = 'http://127.0.0.1:18561'
  const occupied = await fetch(rpcUrl, { method: 'POST', body: '{}', signal: AbortSignal.timeout(500) }).then(() => true, () => false)
  assert.equal(occupied, false, 'Do not attach to an unrelated existing fork')
  fork = spawn(join(homedir(), '.foundry/bin/anvil'), ['--host', '127.0.0.1', '--port', '18561', '--chain-id', '31337', '--fork-url', original.rpcUrl, '--silent'], { stdio: 'ignore' })
  fork.on('error', () => {})
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0 }) })
  for (let attempt = 0; ; attempt++) {
    try { assert.equal(await client.getChainId(), 31337); break } catch (error) { if (attempt > 60) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const manifest = structuredClone(original)
  manifest.rpcUrl = rpcUrl; manifest.worldAssets.rpcUrl = rpcUrl
  manifest.genesisHash = (await client.getBlock({ blockNumber: 0n })).hash; manifest.worldAssets.genesisHash = manifest.genesisHash
  const databaseSettings = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  administrator = new pg.Pool({ connectionString: databaseSettings.databaseUrl, max: 1 })
  await administrator.query('CREATE SCHEMA ' + schema); schemaCreated = true
  const url = new URL(databaseSettings.databaseUrl); url.searchParams.set('options', '-c search_path=' + schema)
  pool = new pg.Pool({ connectionString: url.href, max: 8 })
  const store = Object.create(PostgresStore.prototype); store.pool = pool
  await store.query(await readFile(new URL('../../backend/src/chain/schema.sql', import.meta.url), 'utf8'))
  const records = await createWorldAssetStore(pool), abis = await loadBankAbis(root)
  process.env.PATH = join(homedir(), '.foundry/bin') + ':' + process.env.PATH
  const settings = JSON.parse(await readFile(join(root, '.local/bank/operator-settings.json'), 'utf8'))
  const accounts = { lender: await openDevelopmentKeystore(settings.roles.lender), registrar: await openDevelopmentKeystore(settings.roles.registrar),
    issuer: await openDevelopmentKeystore(settings.roles.issuer), inspector: await openDevelopmentKeystore(settings.roles.inspector),
    borrower: privateKeyToAccount(generatePrivateKey()), seller: privateKeyToAccount(generatePrivateKey()), bidder: privateKeyToAccount(generatePrivateKey()), worker: privateKeyToAccount(generatePrivateKey()) }
  let clock = Number((await client.getBlock()).timestamp) * 1000, signatures = 0, allowed = false, loseReply = false, loseApprovalReply = false, inspected = false
  const ids = Object.fromEntries(Object.keys(accounts).map(name => [name, randomUUID()]))
  const principals = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [ids[name], { principalId: ids[name], walletAddress: account.address.toLowerCase(), operatorControlled: true }]))
  const keys = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [ids[name], account]))
  const resolveIdentity = async ({ principalId }) => principals[principalId]
  for (const account of Object.values(accounts)) await client.request({ method: 'anvil_setBalance', params: [account.address, '0x56bc75e2d63100000'] })
  async function mine(seconds = 1) {
    if (seconds > 1) await client.request({ method: 'evm_increaseTime', params: [seconds] })
    await client.request({ method: 'evm_mine', params: [] })
    if (seconds > 1) await client.request({ method: 'evm_mine', params: [] })
    clock = Number((await client.getBlock({ blockTag: 'latest' })).timestamp) * 1000
  }
  const engine = new DurableEvm({ store, rpcUrl, genesisHash: manifest.genesisHash, chain: foundry })
  engine.validateRequest = async (_tx, request) => {
    if (BigInt(request.gas) > BigInt(manifest.maxGas) || BigInt(request.value || 0) !== 0n) throw Error('fixture_transaction_limit')
  }
  const signing = account => ({ ...account, async signTransaction(request) { signatures++; return account.signTransaction(request) } })
  const adapter = role => ({ ...(role ? { address: accounts[role].address } : {}),
    prepare: async input => {
      const account = role ? accounts[role] : keys[input.playerId]
      assert.ok(account); assert.ok(Object.values(manifest).includes(input.to)); assert.equal(input.value, 0n)
      const result = await engine.prepare(input.operationId, signing(account), input.to, input.data, 0n)
      return { transactionHash: result.transaction_hash, status: result.status }
    },
    broadcast: async input => {
      const result = await engine.broadcast(input.operationId)
      const intent = (await store.query('SELECT destination,calldata FROM ac_chain_intents WHERE operation_id=$1', [input.operationId])).rows[0]
      if (loseReply && intent.destination === manifest.bank && decodeFunctionData({ abi: abis.bank, data: intent.calldata }).functionName === 'takeLoan') {
        loseReply = false; throw Error('fixture_lost_submitted_reply')
      }
      if (loseApprovalReply && intent.destination === manifest.city && decodeFunctionData({ abi: abis.city, data: intent.calldata }).functionName === 'approve') {
        loseApprovalReply = false; throw Error('fixture_lost_approval_reply')
      }
      return result
    },
    reconcile: async input => { await mine(); const result = await engine.receipt(input.operationId, 2); return { ...result, transactionHash: result.hash } }
  })
  const wallets = adapter(), inspector = { ...adapter('inspector'), authorize: async ({ action, workId, termsHash }) => ({ approved: inspected, workId, termsHash,
    ...(action === 'workcomplete' ? { resultHash: keccak256(stringToHex('labelled native inspection fixture')) } : {}) }) }
  const options = { pool, manifest, client, wallets, resolveIdentity, authorize: async () => allowed, inspector, allowLocalFixture: true, now: () => clock }
  let service = await createBankService(options)
  const setupCall = async (who, target, functionName, args) => {
    const wallet = createWalletClient({ account: accounts[who], chain: foundry, transport: http(rpcUrl, { retryCount: 0 }) })
    const hash = await wallet.writeContract({ address: manifest[target], abi: abis[target], functionName, args })
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); await mine(); return receipt
  }
  for (const name of ['borrower', 'bidder']) await setupCall('issuer', 'usdc', 'mint', [accounts[name].address, 20n * 10n ** 6n])
  await setupCall('issuer', 'gem', 'mint', [accounts.borrower.address, 20n * 10n ** 18n])
  await setupCall('issuer', 'city', 'mint', [accounts.borrower.address, 5n * 10n ** 18n])
  const marketplace = await createBankService({ ...options, manifest: { ...manifest, mode: 'marketplace' } })
  const marketplaceSignatures = signatures
  for (const action of ['offer', 'cancel_offer', 'borrow', 'repay', 'auction', 'bid', 'settle', 'claim', 'withdraw']) {
    await assert.rejects(marketplace.preview({ principalId: ids.borrower, operationId: randomUUID(), action }), /MARKETPLACE_ACTION_REQUIRED/)
  }
  await assert.rejects(marketplace.preview({ principalId: ids.borrower, operationId: randomUUID(), action: 'swap',
    tokenIn: 'GEM', tokenOut: 'CITY', amountOut: '1', maxAmountIn: '5' }), /BANK_SUPPORTED_TOKEN_REQUIRED/)
  assert.equal(signatures, marketplaceSignatures)
  check('marketplace refuses lending and GEM before any financial signature')
  for (const [tokenIn, tokenOut] of [['CITY', 'USDC'], ['USDC', 'CITY']]) {
    const quote = await marketplace.preview({ principalId: ids.borrower, operationId: randomUUID(), action: 'swap',
      tokenIn, tokenOut, amountOut: '0.1', maxAmountIn: '5' })
    assert.equal(quote.terms.tokenIn, tokenIn); assert.equal(quote.terms.tokenOut, tokenOut)
  }
  assert.equal(signatures, marketplaceSignatures)
  check('marketplace retains CITY and USDC quote routes without signing a transaction')
  async function mintItem(who) {
    const suffix = randomUUID(), snapshotHash = keccak256(stringToHex('fixture enchanted sword ' + suffix)), nativeReceiptId = keccak256(stringToHex('fixture native receipt ' + suffix))
    const receipt = await setupCall('registrar', 'registry', 'mintItem', [accounts[who].address, manifest.serverId, keccak256(stringToHex('fixture-world')), keccak256(stringToHex(suffix)), snapshotHash, nativeReceiptId])
    const event = parseEventLogs({ abi: abis.registry, eventName: 'AssetRegistered', logs: receipt.logs })[0]
    const tokenId = event.args.tokenId.toString()
    await records.put(manifest.worldAssets.deploymentId, 'asset:' + tokenId, { kind: 'item', tokenId, snapshotHash, nativeReceiptId,
      descriptor: { material: 'diamond_sword', fixture: 'synthetic native custody; no game mutation' } })
    return tokenId
  }
  const preview = (who, action, args = {}) => service.preview({ principalId: ids[who], operationId: runId + ':' + randomUUID(), action, ...args })
  const confirm = (who, value) => service.confirm({ principalId: ids[who], operationId: value.operationId, termsDigest: value.termsDigest, confirmationId: 'fixture:' + randomUUID() })
  const act = async (who, action, args) => { const value = await preview(who, action, args); const done = await confirm(who, value); assert.equal(done.status, 'complete'); return done }
  const balance = (name, who) => client.readContract({ address: manifest[name], abi: abis[name], functionName: 'balanceOf', args: [accounts[who].address] })
  const ownerOf = tokenId => client.readContract({ address: manifest.registry, abi: abis.registry, functionName: 'ownerOf', args: [BigInt(tokenId)] })
  async function offer(tokenId, principal = '3', repayment = '3.03', term = 120) {
    return preview('lender', 'offer', { borrowerPrincipalId: ids.borrower, tokenId, valuation: '10', principal, repayment, term, grace: 60, auctionDuration: 60, auctionReserve: '0.1' })
  }
  const collateral = await mintItem('borrower'), proposal = await offer(collateral)
  const beforeSigns = signatures
  await assert.rejects(marketplace.confirm({ principalId: ids.lender, operationId: proposal.operationId,
    termsDigest: proposal.termsDigest, confirmationId: randomUUID() }), /BANK_RETAINED_OWNER_TERMS_REQUIRED/)
  assert.equal(signatures, beforeSigns)
  check('historical bank confirmation cannot cross the marketplace manifest digest')
  await assert.rejects(confirm('lender', proposal), /BANK_EXPLICIT_OWNER_APPROVAL_REQUIRED/)
  assert.equal(signatures, beforeSigns)
  await assert.rejects(service.preview({ principalId: ids.lender, operationId: proposal.operationId, action: 'offer', borrowerPrincipalId: ids.borrower, tokenId: collateral, valuation: '10', principal: '2', repayment: '2.02', auctionReserve: '0.1' }), /BANK_PREVIEW_IMMUTABLE/)
  await assert.rejects(service.status({ principalId: ids.bidder, operationId: proposal.operationId }), /BANK_RETAINED_OWNER_TERMS_REQUIRED/)
  allowed = true; await confirm('lender', proposal)
  check('owner confirmation and immutable preview gate lender capital')
  const loanId = proposal.terms.loanId, borrow = await preview('borrower', 'borrow', { loanId })
  loseReply = true
  await assert.rejects(confirm('borrower', borrow), /fixture_lost_submitted_reply/)
  service = await createBankService(options)
  const restarted = await confirm('borrower', borrow); assert.equal(restarted.status, 'complete')
  assert.equal((await ownerOf(collateral)).toLowerCase(), manifest.bank)
  const afterBorrowSigns = signatures, borrowedBalance = await balance('usdc', 'borrower')
  await confirm('borrower', borrow); assert.equal(signatures, afterBorrowSigns); assert.equal(await balance('usdc', 'borrower'), borrowedBalance)
  check('service recreation reconciles original signed borrow and never lends twice')
  const cityBefore = await balance('city', 'borrower'), swap = await act('borrower', 'swap', { tokenIn: 'GEM', tokenOut: 'CITY', amountOut: '1', maxAmountIn: '5' })
  assert.equal(await balance('city', 'borrower'), cityBefore + 10n ** 18n)
  assert.ok(BigInt(swap.proofs.at(-1).args.amountIn) <= BigInt(swap.terms.maximum))
  const afterSwapSigns = signatures; await confirm('borrower', swap); assert.equal(signatures, afterSwapSigns)
  check('official two-pool exact-output quote and swap enforce exact receipt and cap')
  const saleToken = await mintItem('seller')
  await setupCall('seller', 'registry', 'approve', [manifest.market, BigInt(saleToken)])
  const currentAsset = await client.readContract({ address: manifest.registry, abi: abis.registry, functionName: 'asset', args: [BigInt(saleToken)] })
  await setupCall('seller', 'market', 'list', [BigInt(saleToken), 10n ** 18n, BigInt(Math.floor(clock / 1000) + 3600), currentAsset.ownershipNonce, currentAsset.revision])
  const sellerCity = await balance('city', 'seller'), checkout = await act('borrower', 'checkout', { tokenId: saleToken, tokenIn: 'GEM', maxAmountIn: '5' })
  assert.equal((await ownerOf(saleToken)).toLowerCase(), accounts.borrower.address.toLowerCase())
  assert.equal(await balance('city', 'seller'), sellerCity + 10n ** 18n)
  assert.equal(checkout.proofs.at(-1).args.ownershipNonce, String(BigInt(checkout.terms.checkout.ownershipNonce) + 2n))
  check('atomic item checkout pays seller and verifies final buyer after two NFT transfers')
  const workId = randomUUID(), termsHash = keccak256(stringToHex('fixture immutable paid platform job'))
  await act('borrower', 'workfund', { workId, workerPrincipalId: ids.worker, termsHash, amount: '1', workDeadline: Math.floor(clock / 1000) + 600, reviewPeriod: 60 })
  await assert.rejects(preview('borrower', 'workstart', { workId }), /BANK_NATIVE_INSPECTION_REQUIRED/)
  inspected = true; await act('borrower', 'workstart', { workId }); await act('borrower', 'workcomplete', { workId })
  await assert.rejects(preview('bidder', 'workaccept', { workId }), /BANK_WORK_REQUESTER_REQUIRED/)
  const workerBefore = await balance('city', 'worker'), accepted = await act('borrower', 'workaccept', { workId })
  assert.equal(await balance('city', 'worker'), workerBefore + 10n ** 18n)
  const acceptedSigns = signatures; await confirm('borrower', accepted); assert.equal(signatures, acceptedSigns)
  check('funded work requires inspector result and requester acceptance and pays once')
  await mine(61)
  await act('borrower', 'repay', { loanId }); await act('borrower', 'claim', { loanId })
  assert.equal((await ownerOf(collateral)).toLowerCase(), accounts.borrower.address.toLowerCase())
  const credit = await service.credits({ principalId: ids.lender }); assert.equal(credit.amountBaseUnits, '3030000')
  await act('lender', 'withdraw', {}); assert.equal((await service.credits({ principalId: ids.lender })).amountBaseUnits, '0')
  check('repayment credits lender exactly and collateral and cash claims release once')
  const second = await offer(collateral, '1', '1.01', 180); await confirm('lender', second)
  await act('borrower', 'borrow', { loanId: second.terms.loanId }); await mine(61)
  await act('borrower', 'repay', { loanId: second.terms.loanId }); await act('borrower', 'claim', { loanId: second.terms.loanId })
  const history = await service.history({ principalId: ids.borrower }); assert.equal(history.timelyLoansRepaid, '2'); assert.equal(Number(history.feePips), 2500)
  check('two qualifying controlled repayments produce the contract-recorded discount')
  for (const [bid, surplus, badDebt] of [['2', '990000', '0'], ['0.5', '0', '510000']]) {
    const next = await offer(collateral, '1', '1.01', 60); await confirm('lender', next)
    const nextId = next.terms.loanId; await act('borrower', 'borrow', { loanId: nextId })
    await assert.rejects(preview('bidder', 'auction', { loanId: nextId }), /BANK_OVERDUE_LOAN_REQUIRED/)
    await mine(121); await act('bidder', 'auction', { loanId: nextId }); await act('bidder', 'bid', { loanId: nextId, amount: bid })
    await mine(61); const settled = await act('bidder', 'settle', { loanId: nextId })
    assert.equal(settled.proofs.at(-1).args.surplus, surplus); assert.equal(settled.proofs.at(-1).args.badDebt, badDebt)
    await act('bidder', 'claim', { loanId: nextId }); assert.equal((await ownerOf(collateral)).toLowerCase(), accounts.bidder.address.toLowerCase())
    if (bid === '2') {
      const asset = await client.readContract({ address: manifest.registry, abi: abis.registry, functionName: 'asset', args: [BigInt(collateral)] })
      await setupCall('bidder', 'registry', 'safeTransferFrom', [accounts.bidder.address, accounts.borrower.address, BigInt(collateral)])
      assert.ok(asset.ownershipNonce > 0n)
    }
  }
  assert.equal(Number((await service.history({ principalId: ids.borrower })).feePips), 3000)
  check('overdue auctions account for borrower surplus and lender shortfall and remove discount')
  const expiring = await preview('borrower', 'swap', { tokenIn: 'CITY', tokenOut: 'USDC', amountOut: '1', maxAmountIn: '5' })
  const expiryCity = await balance('city', 'borrower'), expiryUsdc = await balance('usdc', 'borrower')
  loseApprovalReply = true
  await assert.rejects(confirm('borrower', expiring), /fixture_lost_approval_reply/)
  const expirySigns = signatures; await mine(121); service = await createBankService(options)
  const expired = await confirm('borrower', expiring)
  assert.equal(expired.status, 'reconciliation_required'); assert.equal(signatures, expirySigns)
  assert.equal(await balance('city', 'borrower'), expiryCity); assert.equal(await balance('usdc', 'borrower'), expiryUsdc)
  check('expired partial checkout intent reconciles approval without new signing or token spending')
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'backend/src/bank/service.mjs', 'backend/src/bank/canonical.mjs', 'backend/src/bank/abis.mjs',
    'backend/src/world-assets/canonical.mjs', 'tests/bank/service.mjs'
  ].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  report.status = 'pass'; report.controlledSignatures = signatures; report.sourceChainUnchangedByFixture = true
} catch (error) { report.error = { name: error.name, message: error.shortMessage || error.message }; process.exitCode = 1 }
finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await pool?.end(); if (schemaCreated) await administrator?.query('DROP SCHEMA ' + schema + ' CASCADE'); await administrator?.end()
  fork?.kill('SIGTERM')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: join(directory, 'report.json'), error: report.error }))
}
