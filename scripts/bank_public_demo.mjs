// Actual public-testnet finance and native custody; all participants are
// disclosed operator fixtures. Original confirmations survive every restart.
import assert from 'node:assert/strict'
import { readFile, mkdir, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createBankLaptopRuntime } from '../backend/src/bank/laptop-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const verifyReplay = process.argv.length === 3 && process.argv[2] === '--verify-replay'
assert(process.argv.length === 2 || verifyReplay, 'Use no arguments, or --verify-replay after the completed original run')
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { keccak256, stringToHex, encodeAbiParameters, parseAbiParameters, parseAbi, parseEventLogs } = require('viem')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const directory = join(root, '.local/bank'), path = join(directory, 'public-demo-progress.json')
const release = await acquireLocalLease('agentcity-bank-public-native-demo')
let runtime, progress, attempt, evidence

try {
  const settings = await readJson(join(directory, 'operator-settings.json'))
  const roster = await readJson(join(root, '.local/playable-world/bank-actors.json'))
  assert.equal(roster.nativeSessionsVerified, true, 'Real controlled native sessions must be online')
  runtime = await createBankLaptopRuntime({ rootDirectory: root })
  const actor = role => settings.actors[role]
  const binding = json({ deploymentId: runtime.manifest.deploymentId, genesisHash: runtime.manifest.genesisHash,
    actors: Object.fromEntries(Object.entries(settings.actors).map(([role, value]) => [role,
      { principalId: value.principalId, address: value.wallet.address.toLowerCase(), minecraftPlayerId: value.minecraftPlayerId }])) })
  progress = await readJson(path)
  if (!progress) {
    progress = { schema: 'agentcity.bank-public-native-demo.v1', runId: randomUUID(), binding,
      disclosure: 'Actual Unichain Sepolia and live Minecraft with operator-controlled fixture wallets/clients; not independent-human acceptance, organic demand or real revenue.',
      steps: {}, attempts: [], observations: {}, createdAt: new Date().toISOString() }
    await writeCheckpoint(path, progress)
  }
  assert.deepEqual(progress.binding, binding, 'Preserve original owner, chain and world bindings')
  evidence = join(root, 'evidence/runs/bank-public-native', progress.runId)
  await mkdir(evidence, { recursive: true })
  if (progress.status === 'pass') {
    assert.equal((await readJson(join(evidence, 'report.json')))?.status, 'pass')
    if (verifyReplay) {
      const replay = { replayId: randomUUID(), startedAt: new Date().toISOString(), calls: [] }
      progress.replays ||= []; progress.replays.push(replay); await writeCheckpoint(path, progress)
      try {
        const roles = ['borrower', 'bidder']
        const snapshot = async () => Object.fromEntries(await Promise.all(roles.map(async role => [role, {
          nonce: await runtime.bank.client.getTransactionCount({ address: actor(role).wallet.address, blockTag: 'pending' }),
          tokens: (await runtime.wallets.balances(actor(role).principalId)).tokens } ])))
        replay.before = await snapshot(); await writeCheckpoint(path, progress)
        for (const name of ['borrow-1', 'gem-checkout', 'redeem-purchased-sword', 'redeem-auctioned-original']) {
          const original = progress.steps[name]
          assert.equal(original.result.status, 'complete')
          const request = { principalId: original.request.principalId,
            operationId: original.preview.operationId, termsDigest: original.preview.termsDigest }
          const call = { step: name, request, requestedAt: new Date().toISOString() }
          replay.calls.push(call); await writeCheckpoint(path, progress)
          const repeated = await runtime.confirm(request)
          assert.equal(repeated.status, 'complete')
          assert.deepEqual(repeated.proofs.map(value => value.transactionHash).sort(), original.result.proofs.map(value => value.transactionHash).sort())
          if (original.result.nativeDelivery) {
            assert.equal(repeated.nativeDelivery?.claimed, true)
            assert.equal(repeated.nativeDelivery.fingerprint, original.result.nativeDelivery.fingerprint)
          }
          call.status = 'pass'; call.transactionHashes = repeated.proofs.map(value => value.transactionHash)
          call.nativeDelivery = repeated.nativeDelivery || null; await writeCheckpoint(path, progress)
        }
        replay.after = await snapshot(); assert.deepEqual(replay.after, replay.before)
        replay.status = 'pass'; replay.completedAt = new Date().toISOString()
      } catch (error) {
        replay.status = 'fail'; replay.error = { code: error.code || error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }; throw error
      } finally {
        await writeCheckpoint(path, progress)
        await writeCheckpoint(join(evidence, 'replay-' + replay.replayId + '.json'), json(replay))
      }
      console.log(JSON.stringify({ status: 'pass', reused: true, evidence, replayId: replay.replayId, repeatedConfirmations: replay.calls.length, newSignedTransactions: 0 }))
    } else console.log(JSON.stringify({ status: 'pass', reused: true, evidence, newConfirmations: 0 }))
  } else {
  attempt = { attemptId: randomUUID(), startedAt: new Date().toISOString(), scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), errors: [] }
  progress.attempts.push(attempt)
  const save = () => writeCheckpoint(path, progress)
  const log = async value => {
    const record = json({ at: new Date().toISOString(), ...value })
    const file = await open(join(evidence, 'events.jsonl'), 'a', 0o600)
    try { await file.write(JSON.stringify(record) + '\n'); await file.sync() } finally { await file.close() }
    console.log(JSON.stringify(record))
  }
  await save()
  const principal = role => actor(role).principalId
  const readBank = (functionName, args = []) => runtime.bank.client.readContract({ address: runtime.manifest.bank, abi: runtime.bank.abis.bank, functionName, args })
  const owner = tokenId => runtime.bank.client.readContract({ address: runtime.manifest.registry, abi: runtime.bank.abis.registry, functionName: 'ownerOf', args: [BigInt(tokenId)] })
  const sameAddress = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase())
  const loanId = number => keccak256(stringToHex(progress.runId + ':loan:' + number))

  async function step(name, role, input) {
    const request = { principalId: principal(role), ...input }, digest = hash(request)
    let entry = progress.steps[name]
    if (!entry) { entry = progress.steps[name] = { request, inputDigest: digest, attempts: [], createdAt: new Date().toISOString() }; await save() }
    assert.equal(entry.inputDigest, digest, name + ': immutable original step')
    if (entry.result?.status === 'complete') return entry.result
    try {
      if (!entry.preview) {
        entry.previewRequestedAt = new Date().toISOString(); await save()
        entry.preview = json(await runtime.preview(request)); await save()
        await log({ step: name, stage: 'preview', operationId: entry.preview.operationId })
      }
      for (let index = 0; index < 10; index++) {
        const approval = { principalId: principal(role), operationId: entry.preview.operationId, termsDigest: entry.preview.termsDigest }
        entry.attempts.push({ requestedAt: new Date().toISOString(), operationId: approval.operationId, termsDigest: approval.termsDigest })
        await save()
        entry.result = json(await runtime.confirm(approval)); await save()
        await log({ step: name, stage: 'confirm', operationId: approval.operationId, status: entry.result.status,
          transactions: (entry.result.proofs || []).map(value => value.transactionHash).filter(Boolean) })
        if (entry.result.status === 'complete') return entry.result
        assert(!['expired', 'reverted'].includes(entry.result.status), name + ': original operation needs explicit reconciliation')
        await delay(1000)
      }
      throw Error(name + ': retained operation still pending; rerun only this original confirmation')
    } catch (error) {
      const record = { step: name, stage: entry.preview ? 'confirmation' : 'preview', at: new Date().toISOString(),
        code: error.code || error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }
      attempt.errors.push(record); entry.lastError = record; await save(); await log({ error: record }); throw error
    }
  }

  async function waitFor(timestamp, reason) {
    let lastNotice = 0
    for (;;) {
      const block = await runtime.bank.client.getBlock({ cacheTime: 0 })
      if (Number(block.timestamp) >= timestamp) return
      if (Date.now() - lastNotice > 25000) { await log({ stage: 'waiting_for_chain_time', reason, remainingSeconds: timestamp - Number(block.timestamp) }); lastNotice = Date.now() }
      await delay(Math.min(10000, Math.max(1000, (timestamp - Number(block.timestamp)) * 1000)))
    }
  }

  async function balances() {
    return Object.fromEntries(await Promise.all(['borrower', 'seller', 'bidder', 'lender'].map(async role => [role, await runtime.wallets.balances(principal(role))])))
  }
  async function feeEvidence(name, result, expectedFee) {
    const proof = result.proofs.find(value => value.eventName === 'SwapExecuted')
    assert(proof?.transactionHash, 'Canonical swap proof required')
    const receipt = await runtime.bank.client.getTransactionReceipt({ hash: proof.transactionHash })
    const key = runtime.manifest.pools.cityUsdc
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))
    const events = parseEventLogs({ abi: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
      eventName: 'Swap', logs: receipt.logs.filter(value => value.address.toLowerCase() === runtime.manifest.poolManager), strict: true })
    const actual = events.find(value => value.args.id.toLowerCase() === poolId.toLowerCase())
    assert(actual, 'Official CITY-pool Swap event required'); assert.equal(Number(actual.args.fee), expectedFee)
    progress.observations[name] = json({ transactionHash: proof.transactionHash, poolId, feePips: actual.args.fee, trader: actor('borrower').wallet.address })
    await save()
  }

  if (!progress.observations.beforeBalances) { progress.observations.beforeBalances = await balances(); await save() }
  await runtime.publishHealth()
  const original = await step('register-original-collateral', 'borrower', { action: 'register_item' })
  const sale = await step('register-seller-sword', 'seller', { action: 'register_item' })
  const originalToken = String(original.tokenId), saleToken = String(sale.tokenId)
  assert(/^[1-9][0-9]*$/.test(originalToken) && /^[1-9][0-9]*$/.test(saleToken))
  assert.notEqual(originalToken, saleToken)
  const offer = async (number, principalAmount, repayment, term, auctionDuration = 60) => step('offer-' + number, 'lender', {
    action: 'offer', borrowerId: principal('borrower'), tokenId: originalToken, loanId: loanId(number), valuation: '100',
    principal: principalAmount, repayment, term, grace: 60, auctionDuration, auctionReserve: '1' })
  await offer(1, '10', '10.01', 3600)
  await step('borrow-1', 'borrower', { action: 'borrow', loanId: loanId(1) })
  if (!progress.observations.collateralVaultLock) {
    sameAddress(await owner(originalToken), runtime.manifest.bank)
    progress.observations.collateralVaultLock = { tokenId: originalToken, owner: runtime.manifest.bank }; await save()
  }
  await step('list-seller-sword', 'seller', { action: 'list_item', tokenId: saleToken, price: '5' })
  await runtime.publishHealth()
  const purchase = await step('gem-checkout', 'borrower', { action: 'checkout', tokenId: saleToken, tokenIn: 'GEM', maximum: '8' })
  const purchaseProof = purchase.proofs.find(value => value.eventName === 'CheckoutPurchased')
  assert(purchaseProof && BigInt(purchaseProof.args.amountIn) <= BigInt(purchase.terms.maximum))
  if (!progress.observations.purchaseOwner) {
    sameAddress(await owner(saleToken), actor('borrower').wallet.address)
    progress.observations.purchaseOwner = { tokenId: saleToken, owner: actor('borrower').wallet.address }; await save()
  }
  const deliveredPurchase = await step('redeem-purchased-sword', 'borrower', { action: 'redeem_item', tokenId: saleToken })
  assert.equal(deliveredPurchase.nativeDelivery?.claimed, true)
  assert.equal(deliveredPurchase.nativeDelivery.fingerprint, sale.terms.nativePreview.fingerprint)
  progress.observations.purchasedSwordDelivery = deliveredPurchase.nativeDelivery; await save()
  await log({ milestone: 'actual_seller_sword_delivered_to_borrower', tokenId: saleToken, fingerprint: deliveredPurchase.nativeDelivery.fingerprint })
  let first = await readBank('loan', [loanId(1)])
  await waitFor(Number(first.takenAt) + 62, 'Loan1 minimum qualifying observed duration')
  await step('repay-1', 'borrower', { action: 'repay', loanId: loanId(1) })
  await step('claim-collateral-1', 'borrower', { action: 'claim_collateral', loanId: loanId(1) })
  if (!progress.observations.repaidCollateralOwner) {
    sameAddress(await owner(originalToken), actor('borrower').wallet.address)
    progress.observations.repaidCollateralOwner = { tokenId: originalToken, owner: actor('borrower').wallet.address }; await save()
  }
  await offer(2, '1', '1.001', 3600)
  await step('borrow-2', 'borrower', { action: 'borrow', loanId: loanId(2) })
  const second = await readBank('loan', [loanId(2)])
  await step('seller-auction-funds', 'seller', { action: 'swap', tokenIn: 'CITY', tokenOut: 'USDC', amount: '1', maximum: '2' })
  await waitFor(Number(second.takenAt) + 62, 'Loan2 minimum qualifying observed duration')
  await step('repay-2', 'borrower', { action: 'repay', loanId: loanId(2) })
  await step('claim-collateral-2', 'borrower', { action: 'claim_collateral', loanId: loanId(2) })
  if (!progress.observations.qualifyingHistory) {
    const qualifying = await runtime.bank.history({ principalId: principal('borrower') })
    assert.equal(String(qualifying.timelyLoansRepaid), '2'); assert.equal(Number(qualifying.feePips), 2500)
    progress.observations.qualifyingHistory = qualifying; await save()
  }
  await runtime.publishHealth()
  await feeEvidence('discountSwap', await step('swap-discount-proof', 'borrower', { action: 'swap', tokenIn: 'GEM', tokenOut: 'CITY', amount: '1', maximum: '2' }), 2500)
  await offer(3, '5', '5.005', 60, 180)
  await step('borrow-3', 'borrower', { action: 'borrow', loanId: loanId(3) })
  const third = await readBank('loan', [loanId(3)])
  await waitFor(Number(third.dueAt) + Number(third.terms.grace) + 3, 'Disclosed short testnet loan becomes overdue')
  await step('start-default-auction', 'lender', { action: 'start_auction', loanId: loanId(3) })
  await step('seller-bid-one', 'seller', { action: 'bid', loanId: loanId(3), amount: '1' })
  await step('bidder-outbids-two', 'bidder', { action: 'bid', loanId: loanId(3), amount: '2' })
  if (!progress.observations.outbidRefundCreditBaseUnits) {
    const sellerCredit = await readBank('credits', [actor('seller').wallet.address])
    assert.equal(String(sellerCredit), '1000000')
    progress.observations.outbidRefundCreditBaseUnits = String(sellerCredit); await save()
  }
  const auction = await readBank('loan', [loanId(3)])
  await waitFor(Number(auction.auctionEnd) + 2, 'Actual funded auction reaches its disclosed end')
  const settled = await step('settle-default-auction', 'lender', { action: 'settle_auction', loanId: loanId(3) })
  const settlement = settled.proofs.find(value => value.eventName === 'AuctionSettled')
  assert(settlement); assert.equal(String(settlement.args.proceeds), '2000000'); assert.equal(String(settlement.args.badDebt), '3005000')
  progress.observations.defaultSettlement = { ...settlement, principalLossBaseUnits: '3000000', disclosure: 'Debt shortfall includes the0.005tUSDC unpaid fee; actual principal loss is3tUSDC.' }; await save()
  await step('withdraw-outbid-refund', 'seller', { action: 'withdraw' })
  await step('withdraw-lender-proceeds', 'lender', { action: 'withdraw' })
  await step('claim-auction-collateral', 'bidder', { action: 'claim_collateral', loanId: loanId(3) })
  if (!progress.observations.auctionCollateralOwner) {
    sameAddress(await owner(originalToken), actor('bidder').wallet.address)
    progress.observations.auctionCollateralOwner = { tokenId: originalToken, owner: actor('bidder').wallet.address }; await save()
  }
  const deliveredOriginal = await step('redeem-auctioned-original', 'bidder', { action: 'redeem_item', tokenId: originalToken })
  assert.equal(deliveredOriginal.nativeDelivery?.claimed, true)
  assert.equal(deliveredOriginal.nativeDelivery.fingerprint, original.terms.nativePreview.fingerprint)
  progress.observations.originalSwordDelivery = deliveredOriginal.nativeDelivery; await save()
  await log({ milestone: 'actual_original_sword_delivered_to_bidder', tokenId: originalToken, fingerprint: deliveredOriginal.nativeDelivery.fingerprint })
  const finalHistory = await runtime.bank.history({ principalId: principal('borrower') })
  assert.equal(String(finalHistory.defaults), '1'); assert.equal(String(finalHistory.badDebt), '3005000'); assert.equal(Number(finalHistory.feePips), 3000)
  assert.equal(String(finalHistory.activePrincipal), '0')
  progress.observations.finalHistory = finalHistory; await save()
  await runtime.publishHealth()
  await feeEvidence('defaultSwap', await step('swap-default-proof', 'borrower', { action: 'swap', tokenIn: 'GEM', tokenOut: 'CITY', amount: '1', maximum: '2' }), 3000)
  progress.observations.afterBalances = await balances()
  for (const number of [1, 2, 3]) {
    const value = await readBank('loan', [loanId(number)])
    assert.equal(Number(value.state), number === 3 ? 5 : 4)
  }
  assert.equal(String(await readBank('totalOfferReserves')), '0')
  assert.equal(String(await readBank('totalBidEscrow')), '0')
  assert.equal(String(await readBank('totalCredits')), '0')
  progress.status = 'pass'; attempt.status = 'pass'; attempt.completedAt = new Date().toISOString(); await save()
  await writeCheckpoint(join(evidence, 'report.json'), json({ status: 'pass', schema: progress.schema, runId: progress.runId,
    disclosure: progress.disclosure, manifest: runtime.manifest, binding, steps: progress.steps, observations: progress.observations,
    attempts: progress.attempts, realMoneySpentUsd: 0, independentHumans: 0, paidModelCalls: 0, workFundingTransactions: 0 }))
  await log({ status: 'pass', evidence, completeSteps: Object.keys(progress.steps).length })
  }
} catch (error) {
  if (progress && !attempt) {
    progress.preflightFailures ||= []
    const replay = progress.replays?.at(-1)
    progress.preflightFailures.push({ at: new Date().toISOString(), stage: replay?.status === 'fail' ? 'retained_confirmation_replay' : 'identity_preflight',
      code: error.code || error.name, message: String(error.shortMessage || error.message).slice(0, 1500),
      retainedConfirmationCallsRequested: replay?.status === 'fail' ? replay.calls.length : 0, newTransactionsAuthorized: false })
    await writeCheckpoint(path, progress)
  }
  if (progress && attempt) {
    attempt.status = 'fail'; attempt.completedAt = new Date().toISOString()
    attempt.failure = { code: error.code || error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }
    await writeCheckpoint(path, progress)
    if (evidence) await writeCheckpoint(join(evidence, 'attempt-' + attempt.attemptId + '.json'), json(attempt))
  }
  throw error
} finally { await runtime?.close(); await release() }
