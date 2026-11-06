// Active marketplace proof only: buy CITY, trade exact native equipment and
// repeat retained confirmations. Historical lending is neither read nor called.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createBankLaptopRuntime } from '../backend/src/bank/laptop-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { encodeAbiParameters, parseAbiParameters, parseAbi, parseEventLogs, keccak256 } = require('viem')
const { acquireLocalLease, writeCheckpoint } = require('./src/bot/checkpoint-store.cjs')
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const digest = value => createHash('sha256').update(JSON.stringify(json(value))).digest('hex')
const directory = join(root, '.local/marketplace'), path = join(directory, 'public-demo-progress.json')
const verifyReplay = process.argv.length === 3 && process.argv[2] === '--verify-replay'
assert(process.argv.length === 2 || verifyReplay, 'Use no arguments, or --verify-replay after the completed original run')
const release = await acquireLocalLease('agentcity-public-marketplace-demo')
let runtime, progress, evidence, attempt

try {
  const settings = await readJson(join(root, '.local/bank/operator-settings.json'))
  runtime = await createBankLaptopRuntime({ rootDirectory: root, manifestFile: '.local/marketplace/public-deployment.json' })
  assert.equal(runtime.manifest.mode, 'marketplace')
  const principal = role => settings.actors[role].principalId
  const address = role => settings.actors[role].wallet.address
  const binding = json({ deploymentId: runtime.manifest.deploymentId, genesisHash: runtime.manifest.genesisHash,
    actors: Object.fromEntries(['borrower', 'bidder'].map(role => [role, { principalId: principal(role), address: address(role).toLowerCase(), minecraftPlayerId: settings.actors[role].minecraftPlayerId }])) })
  progress = await readJson(path)
  if (!progress) {
    progress = { schema: 'agentcity.marketplace-public-demo.v1', runId: randomUUID(), binding,
      disclosure: 'Actual Unichain Sepolia and native Minecraft, controlled fixture actors and mock USDC. No lending, independent-human qualification, organic demand or real revenue.',
      steps: {}, attempts: [], observations: {}, replays: [] }
    await writeCheckpoint(path, progress)
  }
  assert.deepEqual(progress.binding, binding)
  evidence = join(root, 'evidence/runs/marketplace-public-native', progress.runId)
  await mkdir(evidence, { recursive: true })
  const save = () => writeCheckpoint(path, progress)
  const walletSnapshot = async () => Object.fromEntries(await Promise.all(['borrower', 'bidder'].map(async role => [role, {
    nonce: await runtime.bank.client.getTransactionCount({ address: address(role), blockTag: 'pending' }),
    tokens: (await runtime.wallets.balances(principal(role))).tokens }])))
  const step = async (name, role, input) => {
    const request = { principalId: principal(role), ...input }
    let saved = progress.steps[name]
    if (!saved) { saved = progress.steps[name] = { request, inputDigest: digest(request), confirmations: [] }; await save() }
    assert.equal(saved.inputDigest, digest(request), 'Original step inputs must remain immutable')
    if (saved.result?.status === 'complete') return saved.result
    if (!saved.preview) { saved.preview = json(await runtime.preview(request)); await save() }
    for (let index = 0; index < 8; index++) {
      const confirmation = { principalId: principal(role), operationId: saved.preview.operationId, termsDigest: saved.preview.termsDigest }
      saved.confirmations.push({ at: new Date().toISOString(), ...confirmation }); await save()
      saved.result = json(await runtime.confirm(confirmation)); await save()
      console.log(JSON.stringify({ step: name, operationId: confirmation.operationId, status: saved.result.status,
        transactionHashes: saved.result.proofs.map(value => value.transactionHash) }))
      if (saved.result.status === 'complete') return saved.result
      assert(!['expired', 'reverted'].includes(saved.result.status), 'Reconcile original expired/reverted terms before any new action')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw Error('Original retained operation remains pending: ' + name)
  }

  if (progress.status === 'pass') {
    if (verifyReplay) {
      const replay = { replayId: randomUUID(), startedAt: new Date().toISOString(), calls: [] }
      progress.replays.push(replay); await save()
      try {
        replay.before = await walletSnapshot(); await save()
        for (const name of ['buy-city', 'usdc-equipment-checkout', 'redeem-exact-sword']) {
          const original = progress.steps[name]
          const input = { principalId: original.request.principalId, operationId: original.preview.operationId, termsDigest: original.preview.termsDigest }
          const call = { name, input, requestedAt: new Date().toISOString() }; replay.calls.push(call); await save()
          const result = await runtime.confirm(input)
          assert.equal(result.status, 'complete')
          assert.deepEqual(result.proofs.map(value => value.transactionHash).sort(), original.result.proofs.map(value => value.transactionHash).sort())
          if (original.result.nativeDelivery) {
            assert.equal(result.nativeDelivery?.claimed, true)
            assert.equal(result.nativeDelivery.fingerprint, original.result.nativeDelivery.fingerprint)
          }
          call.status = 'pass'; call.proofs = result.proofs; call.nativeDelivery = result.nativeDelivery || null; await save()
        }
        replay.after = await walletSnapshot(); assert.deepEqual(replay.after, replay.before)
        replay.status = 'pass'; replay.completedAt = new Date().toISOString()
      } catch (error) { replay.status = 'fail'; replay.error = { name: error.name, message: String(error.shortMessage || error.message).slice(0, 1500) }; throw error }
      finally { await save(); await writeCheckpoint(join(evidence, 'replay-' + replay.replayId + '.json'), json(replay)) }
      console.log(JSON.stringify({ status: 'pass', replayId: replay.replayId, newSignedTransactions: 0, evidence }))
    } else console.log(JSON.stringify({ status: 'pass', reused: true, evidence, newConfirmations: 0 }))
  } else {
    attempt = { attemptId: randomUUID(), startedAt: new Date().toISOString(), status: 'running' }
    progress.attempts.push(attempt); await save()
    const referenceAbi = parseAbi(['function marketReference() view returns(bool ready,int24 meanTick,uint64 anchorTimestamp,uint64 age)'])
    const readReference = () => runtime.bank.client.readContract({ address: runtime.manifest.hook, abi: referenceAbi, functionName: 'marketReference' })
    let reference = await readReference()
    for (let checkpoint = 0; !reference[0] && checkpoint < 21; checkpoint++) {
      const observation = json(await runtime.publishReference())
      progress.observations.referenceWarmup ||= []
      progress.observations.referenceWarmup.push({ at: new Date().toISOString(), ...observation }); await save()
      console.log(JSON.stringify({ stage: 'reference_warmup', checkpoint, pending: observation.pending }))
      await new Promise(resolve => setTimeout(resolve, 31000))
      reference = await readReference()
    }
    assert.equal(reference[0], true, 'Mature actual time-weighted reference required')
    progress.observations.referenceBefore = json(reference)
    if (!progress.observations.beforeWallets) progress.observations.beforeWallets = await walletSnapshot()
    await save(); await runtime.publishHealth()
    const swap = await step('buy-city', 'borrower', { action: 'swap', tokenIn: 'USDC', tokenOut: 'CITY', amount: '1', maximum: '2' })
    const swapProof = swap.proofs.find(value => value.eventName === 'SwapExecuted')
    assert(swapProof); assert.equal(String(swapProof.args.amountOut), '1000000000000000000')
    assert(BigInt(swapProof.args.amountIn) <= BigInt(swap.terms.maximum))
    const receipt = await runtime.bank.client.getTransactionReceipt({ hash: swapProof.transactionHash })
    const key = runtime.manifest.pools.cityUsdc
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))
    const events = parseEventLogs({ abi: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
      eventName: 'Swap', logs: receipt.logs.filter(value => value.address.toLowerCase() === runtime.manifest.poolManager), strict: true })
    const event = events.find(value => value.args.id.toLowerCase() === poolId.toLowerCase())
    assert(event && Number(event.args.fee) >= 3000 && Number(event.args.fee) <= 10000)
    progress.observations.actualMarketFee = json({ transactionHash: swapProof.transactionHash, poolId, feePips: event.args.fee,
      disclosure: 'Market-condition fee, independent of payer credit history.' }); await save()

    const legacy = await readJson(join(root, '.local/bank/public-demo-progress.json'))
    const expectedFingerprint = legacy.observations.purchasedSwordDelivery.fingerprint
    const registered = await step('register-resale-sword', 'borrower', { action: 'register_item', selection: 0 })
    assert.equal(registered.terms.nativePreview.fingerprint, expectedFingerprint, 'Deposit the existing exact sword, not a replacement')
    const tokenId = String(registered.tokenId)
    await step('list-exact-sword', 'borrower', { action: 'list_item', tokenId, price: '1' })
    await runtime.publishHealth()
    const checkout = await step('usdc-equipment-checkout', 'bidder', { action: 'checkout', tokenId, tokenIn: 'USDC', maximum: '2' })
    const proof = checkout.proofs.find(value => value.eventName === 'CheckoutPurchased')
    assert(proof); assert.equal(proof.args.buyer.toLowerCase(), address('bidder').toLowerCase())
    assert.equal(String(proof.args.cityPrice), '1000000000000000000')
    assert(BigInt(proof.args.amountIn) <= BigInt(checkout.terms.maximum))
    const delivered = await step('redeem-exact-sword', 'bidder', { action: 'redeem_item', tokenId })
    assert.equal(delivered.nativeDelivery?.claimed, true)
    assert.equal(delivered.nativeDelivery.fingerprint, expectedFingerprint)
    progress.observations.nativeDelivery = delivered.nativeDelivery; await save()

    await runtime.publishHealth()
    const beforeGuard = await walletSnapshot()
    let refused = false, refusal
    try {
      await runtime.bank.client.simulateContract({ address: runtime.manifest.quoter, abi: runtime.bank.abis.quoter,
        functionName: 'quoteExactOutputSingle', account: address('borrower'), args: [{ poolKey: key,
          zeroForOne: key.currency0.toLowerCase() === runtime.manifest.usdc.toLowerCase(), exactAmount: 11n * 10n ** 18n,
          hookData: encodeAbiParameters(parseAbiParameters('address'), [address('borrower')]) }] })
    } catch (error) {
      const details = []
      for (let value = error, depth = 0; value && depth < 20; value = value.cause, depth++) {
        details.push(String(value.message || ''), String(value.details || ''), JSON.stringify(value.data, (_, item) => typeof item === 'bigint' ? String(item) : item) || '')
      }
      const text = details.join('\n')
      assert(text.includes('trade output cap') || text.toLowerCase().includes(Buffer.from('trade output cap').toString('hex')), 'Expected actual on-chain output-cap rejection, not a network error')
      refused = true; refusal = { message: String(error.shortMessage || error.message).slice(0, 1500), expectedReason: 'trade output cap' }
    }
    assert(refused, 'Oversized official quote must be refused')
    const afterGuard = await walletSnapshot(); assert.deepEqual(afterGuard, beforeGuard)
    progress.observations.oversizedQuoteRefusal = { ...refusal, before: beforeGuard, after: afterGuard, newSignedTransactions: 0 }
    progress.observations.afterWallets = afterGuard
    progress.status = 'pass'; attempt.status = 'pass'; attempt.completedAt = new Date().toISOString(); await save()
    await writeCheckpoint(join(evidence, 'report.json'), json({ status: 'pass', schema: progress.schema, runId: progress.runId,
      binding, manifest: runtime.manifest, disclosure: progress.disclosure, steps: progress.steps, observations: progress.observations,
      attempts: progress.attempts, newLendingTransactions: 0, newlyIssuedTokens: 0, paidModelCalls: 0, newWorkFunding: 0,
      priorCompletedNativeWorkProof: 'evidence/runs/bank-native-work/cd5aa76c-d53b-41bd-9bd4-15ab81c75d16/report.json' }))
    console.log(JSON.stringify({ status: 'pass', evidence, completeSteps: Object.keys(progress.steps).length }))
  }
} catch (error) {
  if (progress) {
    progress.failures ||= []; progress.failures.push({ at: new Date().toISOString(), name: error.code || error.name, message: String(error.shortMessage || error.message).slice(0, 1500) })
    if (attempt) { attempt.status = 'fail'; attempt.completedAt = new Date().toISOString() }
    await writeCheckpoint(path, progress)
    if (evidence) await writeCheckpoint(join(evidence, 'failure-' + randomUUID() + '.json'), json(progress.failures.at(-1)))
  }
  throw error
} finally { await runtime?.close(); await release() }
