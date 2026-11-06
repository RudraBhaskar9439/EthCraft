import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { formatUnits, formatEther, keccak256, stringToHex, zeroAddress } from 'viem'
import { createWorldAssets } from '../world-assets/service.mjs'
import { createWorldAssetStore } from '../world-assets/store.mjs'
import { digest, json, lower } from '../world-assets/canonical.mjs'
import { createBankService, bankOperationId } from './service.mjs'
import { createBankOperatorWallets } from './operator-wallets.mjs'
import { loadBankAbis } from './abis.mjs'
import { createBankHealthPublisher } from './health-publisher.mjs'
import { createBankNativeWork } from './native-work.mjs'
import { createPoolObservationPublisher } from './pool-observations.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const symbol = name => name === 'USDC' ? 'tUSDC' : name
const date = seconds => seconds ? new Date(Number(seconds) * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'Not set'
const display = (value, decimals = 6) => formatUnits(BigInt(value || 0), decimals)
const actionMap = { start_auction: 'auction', settle_auction: 'settle', claim_collateral: 'claim',
  fund_work: 'workfund', accept_work: 'workaccept', refund_work: 'workrefund' }

export async function createBankLaptopRuntime({ rootDirectory, manifestFile = '.local/bank/public-deployment.json' }) {
  const manifest = JSON.parse(await readFile(join(rootDirectory, manifestFile), 'utf8'))
  const marketplace = manifest.mode === 'marketplace'
  const database = JSON.parse(await readFile(join(rootDirectory, '.local/backend/environment.json'), 'utf8'))
  const active = JSON.parse(await readFile(join(rootDirectory, '.local/playable-world/active.json'), 'utf8'))
  if (active.owner !== 'agentcity-playable-pilot' || !/^agentcity-playable-[a-f0-9]{8}$/.test(active.container)) fail('BANK_OWNED_LAPTOP_WORLD_REQUIRED')
  if (!active.serverId || keccak256(stringToHex(active.serverId)).toLowerCase() !== manifest.serverId.toLowerCase()) {
    fail('BANK_NATIVE_NAMESPACE_CHANGED')
  }
  const runtimeDirectory = active.runtime
  const apiToken = (await readFile(join(runtimeDirectory, 'api-token'), 'utf8')).trim()
  const require = createRequire(new URL('../../package.json', import.meta.url))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: database.databaseUrl, max: 12 })
  const wallets = await createBankOperatorWallets({ rootDirectory, pool, manifest })
  const settings = wallets.settings, actors = Object.values(settings.actors)
  const abis = await loadBankAbis(rootDirectory), store = await createWorldAssetStore(pool)
  if (marketplace) abis.hook = JSON.parse(await readFile(join(rootDirectory,
    'contracts/out/AgentCityMarketplaceHook.sol/AgentCityMarketplaceHook.json'), 'utf8')).abi
  const context = new AsyncLocalStorage()
  const authorize = request => {
    const accepted = context.getStore()
    return accepted && ['principalId', 'operationId', 'termsDigest', 'confirmationId'].every(key => accepted[key] === request[key])
  }
  const actor = principalId => {
    const value = actors.find(entry => entry.principalId === principalId)
    if (!value) fail('BANK_OPERATOR_KNOWN_ACTOR_REQUIRED')
    return value
  }
  const resolveIdentity = async ({ principalId }) => {
    const value = actor(principalId)
    return { ...value, walletAddress: lower(value.wallet.address), address: lower(value.wallet.address) }
  }
  const native = async (path, body) => {
    const response = await fetch('http://127.0.0.1:25597/playable/' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + apiToken,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok) fail(/^[A-Za-z0-9_]+$/.test(result.reason || result.error || '') ? result.reason || result.error : 'BANK_NATIVE_OPERATION_UNAVAILABLE')
    return result
  }
  const assets = await createWorldAssets({ pool, manifest: manifest.worldAssets, wallets, client: wallets.client,
    registrar: wallets.role('registrar'), native, resolveIdentity: async input => {
      const value = await resolveIdentity(input)
      if (!value.minecraftPlayerId) fail('BANK_NATIVE_PLAYER_BINDING_REQUIRED')
      // The reused asset adapter requires a subject field. This value explicitly
      // denotes our disclosed operator fixture and is never a Privy credential.
      return { ...value, privySubject: 'operator-controlled-test:' + value.principalId }
    }, resolveWalletOwner: async ({ walletAddress }) => {
      const value = actors.find(entry => lower(entry.wallet.address) === lower(walletAddress))
      return value ? { principalId: value.principalId } : null
    }, authorize })
  let nativeWork
  const inspectorSigner = wallets.role('inspector')
  const inspector = { ...inspectorSigner, authorize: request => {
    if (!nativeWork) fail('BANK_NATIVE_WORK_NOT_READY')
    return nativeWork.authorize(request)
  } }
  const bank = await createBankService({ pool, manifest, client: wallets.client, wallets, resolveIdentity, authorize, assetService: assets,
    inspector, rootDirectory, abis })
  nativeWork = await createBankNativeWork({ rootDirectory, manifest, wallets, native, resolveIdentity,
    store, client: bank.client, abis, runtimeDirectory })
  const uiGet = key => store.get(manifest.deploymentId, 'ui:' + key)
  const uiPut = (key, value) => store.put(manifest.deploymentId, 'ui:' + key, json(value))
  const healthPublisher = createBankHealthPublisher({ store, manifest, client: bank.client,
    abi: abis.stateRegistry, publisher: wallets.role('publisher'), reader: bank.reader, native })
  const publishReference = marketplace ? createPoolObservationPublisher({ store, manifest, reader: bank.reader,
    publisher: wallets.role('publisher'), abi: abis.hook }) : undefined
  const labelFor = address => actors.find(value => lower(value.wallet.address) === lower(address))?.label
    || (lower(address) === manifest.bank ? 'Collateral vault' : lower(address) === zeroAddress ? 'None' : address)
  const short = id => id.slice(-8)
  const assetName = value => {
    const material = value.item || value.descriptor?.material || value.descriptor?.type || 'Equipment'
    return String(material).replace(/^minecraft:/, '').replaceAll('_', ' ') + ' #' + value.tokenId
  }
  const summaries = row => {
    const t = row.terms || {}, list = [['Action', row.action], ['Wallet', actor(row.principalId).label]]
    const add = (name, value) => { if (value !== undefined && value !== null) list.push([name, String(value)]) }
    if (t.loanTerms) {
      add('Collateral item', '#' + t.loanTerms.tokenId); add('Borrower', labelFor(t.loanTerms.borrower))
      add('Reference valuation', display(t.loanTerms.valuation) + ' tUSDC (lender quote)')
      add('Reserved principal', display(t.loanTerms.principal) + ' tUSDC')
      add('Total repayment', display(t.loanTerms.repayment) + ' tUSDC')
      add('Term', t.loanTerms.term + ' seconds'); add('Grace period', t.loanTerms.grace + ' seconds')
      add('Auction duration', t.loanTerms.auctionDuration + ' seconds')
    } else if (t.loan) {
      add('Loan', short(t.loanId)); add('Item', '#' + t.loan.terms.tokenId)
      add('Total debt', display(t.loan.terms.repayment) + ' tUSDC'); add('Due', date(t.loan.dueAt))
      if (row.action === 'bid') add('Your funded bid', display(t.amount) + ' tUSDC')
    }
    if (t.tokenIn) {
      add('Receive', display(t.amountOut, t.tokenOut === 'USDC' ? 6 : 18) + ' ' + symbol(t.tokenOut))
      add('Estimated spend', display(t.quotedInput, t.tokenIn === 'USDC' ? 6 : 18) + ' ' + symbol(t.tokenIn))
      add('Maximum spend', display(t.maximum, t.tokenIn === 'USDC' ? 6 : 18) + ' ' + symbol(t.tokenIn))
      add('Quote expires', date(t.deadline))
    }
    if (t.checkout) add('Purchase', 'Item #' + t.checkout.tokenId + ' from ' + labelFor(t.checkout.seller))
    if (t.workId) { add('Work', short(t.workId)); add('Worker', labelFor(t.worker || t.work?.worker));
      add('Payment', display(t.amount || t.work?.amount, 18) + ' CITY'); add('Work deadline', date(t.workDeadline || t.work?.deadline)) }
    if (row.action === 'withdraw') add('Available credit', display(t.amount) + ' tUSDC')
    if (t.asset) add('Item', '#' + t.asset.tokenId)
    if (t.price) add('Listing price', display(t.price, 18) + ' CITY')
    if (t.nativePreview) { add('Item', t.nativePreview.item || 'Exact held equipment'); add('Quantity', t.nativePreview.count || 1) }
    add('Gas cap per transaction', display(manifest.maxNativeCostWei, 18) + ' test ETH')
    return list
  }
  function uiView(row, category) {
    return { principalId: row.principalId, operationId: row.operationId, termsDigest: row.termsDigest,
      action: row.action, status: row.status, message: row.message, review: summaries(row), exact: row,
      consented: Boolean(row.consented), canConfirm: !['complete', 'confirmed', 'expired', 'reverted'].includes(row.status)
        && (row.consented || Date.now() < row.expiresAtMs), category }
  }
  async function remember(owner, category, row) {
    const value = { ...row, principalId: owner.principalId }
    await uiPut('operation:' + row.operationId, { principalId: owner.principalId, operationId: row.operationId,
      category, createdAtMs: Date.now(), action: row.action })
    return uiView(value, category)
  }
  async function operation({ principalId, operationId }) {
    actor(principalId)
    const saved = await uiGet('operation:' + operationId)
    if (!saved || saved.principalId !== principalId) fail('BANK_UI_RETAINED_OWNER_REQUIRED')
    const value = await (saved.category === 'asset' ? assets : bank).status({ principalId, operationId })
    const [delivery, execution, release] = await Promise.all(['delivery:', 'execution:', 'release:'].map(prefix => uiGet(prefix + operationId)))
    const followup = delivery?.status === 'pending' ? ['delivery_pending', 'Redemption is confirmed. Join the game to reconcile delivery of the original item.']
      : execution?.status === 'pending' ? ['native_execution_pending', 'Funding and the original start are confirmed. Resume the same native task.']
        : release?.status === 'pending' ? ['native_release_pending', 'Payment is settled. Reconcile release of the protected work area.'] : null
    const visible = followup ? { ...value, status: followup[0], consented: true, message: followup[1] } : value
    return uiView({ ...visible, principalId }, saved.category)
  }
  async function preview(input) {
    const owner = actor(input.principalId), principalId = owner.principalId
    const operationId = randomUUID(), action = input.action
    if (marketplace && !['register_item', 'list_item', 'redeem_item', 'cancel_listing', 'swap', 'checkout',
      'fund_work', 'run_work', 'accept_work', 'refund_work'].includes(action)) fail('MARKETPLACE_ACTION_REQUIRED')
    const base = { principalId, operationId }
    if (action === 'register_item') return remember(owner, 'asset', await assets.previewMint({ ...base,
      kind: 'item', sourceKind: 'player_inventory', selection: input.selection ?? 'main_hand', count: 1 }))
    if (action === 'list_item') {
      const { parseUnits } = await import('viem')
      if (typeof input.price !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(input.price)) fail('BANK_CITY_PRICE_REQUIRED')
      return remember(owner, 'asset', await assets.previewList({ ...base, tokenId: input.tokenId,
        priceBaseUnits: String(parseUnits(input.price, 18)), expiry: Math.floor(Date.now() / 1000) + 86400 }))
    }
    if (action === 'redeem_item') return remember(owner, 'asset', await assets.previewRedeem({ ...base, tokenId: input.tokenId }))
    if (action === 'cancel_listing') return remember(owner, 'asset', await assets.previewCancel({ ...base, tokenId: input.tokenId }))
    if (action === 'run_work') return prepareWorkStart(owner, input.workId, operationId)
    const request = { ...base, action: actionMap[action] || action }
    for (const name of ['borrowerId', 'tokenId', 'valuation', 'principal', 'repayment', 'auctionReserve', 'loanId',
      'term', 'grace', 'auctionDuration', 'tokenIn', 'tokenOut', 'workId']) if (input[name] !== undefined) request[name] = input[name]
    if (action === 'swap') { request.amountOut = input.amount; request.maxAmountIn = input.maximum }
    if (action === 'checkout') request.maxAmountIn = input.maximum
    if (action === 'bid') request.amount = input.amount
    if (action === 'fund_work') {
      if (!nativeWork) fail('BANK_NATIVE_WORK_NOT_READY')
      const worker = actor(input.workerId), sourceWorkId = randomUUID()
      if (input.task !== 'platform' || !worker.ownerPrincipalId) fail('BANK_SUPPORTED_NATIVE_WORK_REQUIRED')
      const plan = { action: 'build_platform', width: 2, depth: 2, material: 'oak_planks' }
      const terms = { sourceWorkId, requesterId: principalId, workerId: worker.principalId, plan, amount: input.amount }
      const termsHash = '0x' + digest(terms), workId = keccak256(stringToHex(sourceWorkId))
      await nativeWork.prepare({ ...terms, workId, termsHash })
      Object.assign(request, { workerPrincipalId: worker.principalId, workId: sourceWorkId, termsHash,
        amount: input.amount, workDeadline: Math.floor(Date.now() / 1000) + 3600, reviewPeriod: 3600 })
    }
    return remember(owner, 'bank', await bank.preview(request))
  }
  async function prepareWorkStart(owner, workId, operationId) {
    if (!nativeWork) fail('BANK_NATIVE_WORK_NOT_READY')
    const chainWork = await bank.client.readContract({ address: manifest.workEscrow, abi: abis.workEscrow,
      functionName: 'work', args: [workId] })
    if (Number(chainWork.state) === 2) {
      const entries = await store.list(manifest.deploymentId, 'ui:operation:')
      for (const entry of entries.filter(value => value.principalId === owner.principalId && value.action === 'workstart')) {
        const old = await bank.status({ principalId: owner.principalId, operationId: entry.operationId })
        if (old.terms.workId === workId) {
          await uiPut('execution:' + entry.operationId, { status: 'pending', workId })
          return operation({ principalId: owner.principalId, operationId: entry.operationId })
        }
      }
      fail('BANK_ORIGINAL_NATIVE_START_REQUIRED')
    }
    const row = await bank.preview({ principalId: owner.principalId, operationId, action: 'workstart', workId })
    return remember(owner, 'bank', row)
  }
  async function confirm(input) {
    const retained = await operation(input)
    if (retained.termsDigest !== input.termsDigest) fail('BANK_UI_EXACT_TERMS_REQUIRED')
    const request = { principalId: input.principalId, operationId: input.operationId,
      termsDigest: input.termsDigest, confirmationId: randomUUID() }
    const service = retained.category === 'asset' ? assets : bank
    const result = await context.run(request, () => service.confirm(request))
    if (retained.category === 'asset' && result.action === 'redeem' && result.status === 'complete') {
      const owner = actor(input.principalId)
      await uiPut('delivery:' + input.operationId, { status: 'pending' })
      try {
        const session = await native('session?playerId=' + owner.minecraftPlayerId)
        if (!session.online || session.principalId !== owner.principalId || session.pendingAuthentication !== false) fail('BANK_JOIN_FOR_ITEM_DELIVERY')
        const receipt = await native('escrow/claim', { operationId: bankOperationId('bank-delivery:' + input.operationId),
          mailboxId: result.terms.backing.nativeListingId, ownerId: owner.principalId, playerId: owner.minecraftPlayerId,
          connectionId: session.connectionId })
        if (receipt.claimed !== true || receipt.ownerId !== owner.principalId
          || receipt.fingerprint !== result.terms.backing.fingerprint) fail('BANK_EXACT_NATIVE_DELIVERY_REQUIRED')
        await uiPut('delivery:' + input.operationId, { status: 'complete', receipt })
        result.nativeDelivery = receipt
        result.message = 'Redemption confirmed and the original exact item delivered into the approved player inventory.'
      } catch (error) {
        await uiPut('delivery:' + input.operationId, { status: 'pending', reason: error.code || 'BANK_NATIVE_DELIVERY_WAITING' })
        result.status = 'delivery_pending'
        result.message = 'Redemption is confirmed. The original item remains in its protected mailbox until delivery can be reconciled.'
      }
    }
    if (retained.action === 'workstart' && result.status === 'complete') {
      const workId = result.terms.workId
      await uiPut('execution:' + input.operationId, { status: 'pending', workId })
      const current = await bank.client.readContract({ address: manifest.workEscrow, abi: abis.workEscrow,
        functionName: 'work', args: [workId] })
      if (Number(current.state) === 2) {
        await nativeWork.run({ workId, principalId: input.principalId })
        const completed = await bank.preview({ principalId: input.principalId, operationId: bankOperationId('native-result:' + workId), action: 'workcomplete', workId })
        const accepted = { principalId: input.principalId, operationId: completed.operationId,
          termsDigest: completed.termsDigest, confirmationId: bankOperationId('native-result-confirm:' + workId) }
        const completion = await context.run(accepted, () => bank.confirm(accepted))
        if (completion.status !== 'complete') return { ...completion, status: 'native_execution_pending' }
      } else if (![3, 4, 5].includes(Number(current.state))) fail('BANK_ORIGINAL_FUNDED_WORK_REQUIRED')
      await uiPut('execution:' + input.operationId, { status: 'complete', workId })
    }
    if (['workaccept', 'workrefund'].includes(retained.action) && result.status === 'complete') {
      await uiPut('release:' + input.operationId, { status: 'pending', workId: result.terms.workId })
      await nativeWork?.releaseIfSettled(result.terms.workId)
      await uiPut('release:' + input.operationId, { status: 'complete', workId: result.terms.workId })
    }
    return result
  }
  const marketHealth = healthPublisher.status, publishHealth = healthPublisher.publish
  async function priceProtection() {
    const block = await bank.reader.snapshot()
    const read = functionName => bank.client.readContract({ address: manifest.hook, abi: abis.hook,
      functionName, args: functionName === 'feeFor' ? [zeroAddress] : [], blockNumber: BigInt(block.blockNumber) })
    const [reference, feePips] = await Promise.all([read('marketReference'), read('feeFor')])
    const [ready, meanTick, anchorTimestamp, age] = reference
    const cityIsZero = lower(manifest.pools.cityUsdc.currency0) === lower(manifest.city)
    const ratio = Math.pow(1.0001, Number(meanTick))
    const usdcPerCity = cityIsZero ? ratio * 1e12 : 1e12 / ratio
    await bank.reader.unchanged(block)
    return { ready, meanTick: Number(meanTick), anchorTimestamp: Number(anchorTimestamp), age: Number(age),
      feePips: Number(feePips), usdcPerCity: ready ? usdcPerCity.toPrecision(6) : null,
      message: ready ? `Reference: about ${usdcPerCity.toPrecision(6)} test USDC per CITY over ${age} seconds. Current market fee ${Number(feePips) / 10000}%. Trade size, liquidity and execution checks still apply.`
        : 'Trading needs a mature funded reference. Record a pool observation and allow at least five minutes of sufficient liquidity; a long idle period requires warming the reference again.' }
  }
  async function state(principalId = settings.actors.borrower.principalId) {
    const owner = actor(principalId), address = lower(owner.wallet.address)
    const [balance, allAssets, loanResult, history, workResult, health, operations] = await Promise.all([
      wallets.balances(principalId), assets.browse(), marketplace ? { loans: [] } : bank.loans({ principalId }),
      marketplace ? null : bank.history({ principalId }),
      bank.works({ principalId }), marketHealth(), store.list(manifest.deploymentId, 'ui:operation:') ])
    const loans = loanResult.loans.map(value => {
      const stateName = value.status[0].toUpperCase() + value.status.slice(1), actions = [], t = value.terms
      const isBorrower = lower(t.borrower) === address, isLender = address === lower(manifest.roles.lender)
      const clock = Date.now() / 1000
      if (value.status === 'offered' && isBorrower && Number(t.offerExpiry) > clock) actions.push({ action: 'borrow', label: 'Review borrowing' })
      if (value.status === 'offered' && isLender) actions.push({ action: 'cancel_offer', label: 'Cancel offer and release reserve' })
      if (['active', 'auction'].includes(value.status) && isBorrower && (value.status !== 'auction' || clock < Number(value.auctionEnd))) actions.push({ action: 'repay', label: 'Review repayment' })
      if (value.status === 'active' && clock >= Number(value.dueAt) + Number(t.grace)) actions.push({ action: 'start_auction', label: 'Start overdue auction' })
      if (value.status === 'auction' && clock >= Number(value.auctionEnd)) actions.push({ action: 'settle_auction', label: 'Settle ended auction' })
      if (lower(value.collateralClaimant) === address) actions.push({ action: 'claim_collateral', label: 'Claim released item ownership' })
      return { ...value, state: stateName, label: 'Loan ' + short(value.loanId) + ' — item #' + t.tokenId,
        description: labelFor(t.borrower) + ' borrowed ' + display(t.principal) + ' tUSDC; repayment '
          + display(t.repayment) + ' tUSDC. Due ' + date(value.dueAt) + (value.status === 'auction' ? '. Auction ends ' + date(value.auctionEnd) : '')
          + (value.status === 'liquidated' ? '. Auction cash ' + display(value.highestBid) + ' tUSDC; unpaid contractual debt '
            + display(BigInt(t.repayment) > BigInt(value.highestBid) ? BigInt(t.repayment) - BigInt(value.highestBid) : 0n)
            + '; principal loss ' + display(BigInt(t.principal) > BigInt(value.highestBid) ? BigInt(t.principal) - BigInt(value.highestBid) : 0n) + ' tUSDC.' : ''), actions }
    })
    const assetRows = allAssets.assets.filter(value => !value.redeemed).map(value => ({ ...value,
      label: assetName(value), description: value.descriptor ? JSON.stringify(value.descriptor) : 'Exact deposited item',
      ownerLabel: labelFor(value.owner), owned: value.owner === address,
      locked: value.owner === manifest.bank, price: display(value.listing.priceBaseUnits, 18) }))
    const work = workResult.works.map(value => {
      const actions = [], isRequester = lower(value.requester) === address, clock = Date.now() / 1000
      if (isRequester && ['funded', 'running'].includes(value.status)) actions.push({ action: 'run_work', label: value.status === 'running' ? 'Resume original native task' : 'Run funded native task' })
      if (isRequester && value.status === 'completed') actions.push({ action: 'accept_work', label: 'Review verified result and pay worker' })
      if (isRequester && ['funded', 'running', 'completed'].includes(value.status)
        && clock >= Number(value.deadline) + (value.status === 'completed' ? Number(value.reviewPeriod) : 0)) actions.push({ action: 'refund_work', label: 'Review eligible refund' })
      return { ...value, state: value.status, label: 'Work ' + short(value.workId),
        description: display(value.amount, 18) + ' CITY reserved for ' + labelFor(value.worker) + '. Deadline ' + date(value.deadline), actions }
    })
    const rows = []
    for (const entry of operations.filter(value => value.principalId === principalId).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 15)) {
      try {
        const view = await operation({ principalId, operationId: entry.operationId }), value = view.exact
        rows.push({ operationId: entry.operationId, label: entry.action, message: value.message, status: value.status,
          receipts: (value.proofs || []).filter(proof => proof.transactionHash).map(proof => ({ url: 'https://sepolia.uniscan.xyz/tx/' + proof.transactionHash })) })
      } catch { rows.push({ operationId: entry.operationId, label: entry.action, status: 'reconciliation_required', message: 'Retained operation needs reconciliation.' }) }
    }
    return { principalId, priceProtection: marketplace ? await priceProtection() : undefined,
      actors: actors.filter(value => !marketplace || value.role !== 'lender').map(value => ({ principalId: value.principalId, label: value.label, role: value.role, minecraftUsername: value.minecraftUsername })),
      balances: { city: display(balance.tokens.city, 18), usdc: display(balance.tokens.usdc), gem: display(balance.tokens.gem, 18), eth: formatEther(BigInt(balance.nativeWei)) },
      assets: assetRows, loans, work, operations: rows, marketHealth: health,
      historySummary: marketplace ? undefined : `${history.timelyLoansRepaid} qualifying timely repayments; ${history.defaults} defaults. Current CITY-pool swap fee ${Number(history.feePips) / 10000}%.`,
      deployment: { chainId: manifest.chainId, deploymentId: manifest.deploymentId, registry: manifest.registry, ...(!marketplace ? { bank: manifest.bank } : {}),
        router: manifest.router, hook: manifest.hook, workEscrow: manifest.workEscrow, mockUsdc: manifest.usdc,
        disclosure: 'New laptop namespace. Operator test wallets; no real USD backing or independent-human qualification.' } }
  }
  return { state, preview, confirm, operation, publishHealth, publishReference, bank, assets, wallets, pool, manifest, native, nativeWork,
    async close() { await nativeWork?.close?.(); await pool.end() } }
}
