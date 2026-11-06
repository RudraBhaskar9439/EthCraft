import { createHash } from 'node:crypto'
import { encodeFunctionData, encodeAbiParameters, keccak256, stringToHex, parseUnits, formatUnits } from 'viem'
import { createBankRpcClient } from './rpc.mjs'
import { createWorldAssetStore } from '../world-assets/store.mjs'
import { digest, json, lower, hex32 } from '../world-assets/canonical.mjs'
import { loadBankAbis } from './abis.mjs'
import { validateBankManifest, createBankReader } from './canonical.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail = code => { throw Object.assign(Error(code), { code }) }
export const bankOperationId = value => {
  const h = createHash('sha256').update(String(value)).digest('hex')
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-')
}
const chainId = value => hex32(value) ? value.toLowerCase() : keccak256(stringToHex(String(value)))
const UINT128 = (1n << 128n) - 1n
const names = ['none', 'offered', 'active', 'auction', 'repaid', 'liquidated', 'cancelled']
const workNames = ['none', 'funded', 'running', 'completed', 'accepted', 'refunded']
const marketplaceActions = new Set(['swap', 'checkout', 'workfund', 'workstart', 'workcomplete', 'workaccept', 'workrefund'])
const aliases = { takeLoan: 'borrow', offerLoan: 'offer', cancelOffer: 'cancel_offer', startAuction: 'auction',
  settleAuction: 'settle', claimCollateral: 'claim', swapExactOutput: 'swap', buyWithSwap: 'checkout',
  fundWork: 'workfund', startWork: 'workstart', recordCompletion: 'workcomplete', acceptWork: 'workaccept', refundWork: 'workrefund' }
const boundedInteger = (value, minimum, maximum, code) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(code)
  return number
}
const units = (request, field, decimals, maximum = UINT128) => {
  let value
  const raw = request[field + 'BaseUnits']
  if (raw !== undefined) {
    if (!/^[1-9][0-9]*$/.test(String(raw))) fail('BANK_POSITIVE_INTEGER_AMOUNT_REQUIRED')
    value = BigInt(raw)
  } else {
    if (typeof request[field] !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(request[field])
      || (request[field].split('.')[1]?.length || 0) > decimals) fail('BANK_DECIMAL_STRING_AMOUNT_REQUIRED')
    value = parseUnits(request[field], decimals)
  }
  if (value <= 0n || value > maximum) fail('BANK_AMOUNT_LIMIT_EXCEEDED')
  return value
}

/** Testnet banking behind immutable previews and explicit owner confirmation. */
export async function createBankService({ pool, manifest: input, client: suppliedClient, wallets, resolveIdentity, authorize,
  assetService, workOrders, inspector, rootDirectory, abis: suppliedAbis, store: suppliedStore,
  allowLocalFixture = false, now = Date.now } = {}) {
  if (!wallets?.prepare || !wallets?.broadcast || !wallets?.reconcile || typeof resolveIdentity !== 'function'
    || typeof authorize !== 'function' || typeof now !== 'function') fail('BANK_DURABLE_AUTHORITIES_REQUIRED')
  const manifest = validateBankManifest(input, { allowLocalFixture })
  const abis = suppliedAbis || await loadBankAbis(rootDirectory)
  const client = suppliedClient || await createBankRpcClient(manifest)
  const reader = createBankReader({ client, manifest, abis, now })
  const store = suppliedStore || await createWorldAssetStore(pool)
  const deployment = manifest.deploymentId, manifestDigest = digest(manifest)
  const get = key => store.get(deployment, 'bank:' + key)
  const put = (key, value) => store.put(deployment, 'bank:' + key, json(value))
  const cap = token => BigInt(token === 'USDC' ? manifest.maxUsdcAmountBaseUnits : manifest.maxCityAmountBaseUnits)
  const tokens = { CITY: { address: manifest.city, decimals: 18 }, GEM: { address: manifest.gem, decimals: 18 }, USDC: { address: manifest.usdc, decimals: 6 } }
  const token = value => { const entry = tokens[value]; if (!entry || manifest.mode === 'marketplace' && value === 'GEM') fail('BANK_SUPPORTED_TOKEN_REQUIRED'); return entry }
  const read = (target, functionName, args = [], block) => client.readContract({ address: manifest[target], abi: abis[target], functionName, args,
    ...(block ? { blockNumber: BigInt(block.blockNumber) } : {}) })
  await reader.verify()

  async function actor(principalId) {
    if (!UUID.test(principalId || '')) fail('BANK_AUTHENTICATED_OWNER_REQUIRED')
    const value = await resolveIdentity({ principalId })
    if (!value || value.principalId !== principalId || (!value.privySubject && value.operatorControlled !== true)) fail('BANK_VERIFIED_OR_DISCLOSED_TEST_ACTOR_REQUIRED')
    return { ...value, walletAddress: lower(value.walletAddress || value.address || value.wallet?.address) }
  }
  const binding = value => ({ principalId: value.principalId, walletAddress: value.walletAddress,
    subjectHash: value.privySubject ? digest(value.privySubject) : null, operatorControlled: value.operatorControlled === true })
  const view = row => json({ operationId: row.originalOperationId, previewId: row.id, action: row.action, status: row.status,
    termsDigest: row.termsDigest, expiresAtMs: row.expiresAtMs, terms: row.terms, message: row.message,
    consented: Boolean(row.consentedAtMs), proofs: Object.values(row.stages).map(stage => stage.proof).filter(Boolean),
    disclosure: row.owner.operatorControlled ? 'Operator-controlled test actor; not independent human approval.' : 'Owner-confirmed managed wallet.' })
  async function retained(principalId, operationId) {
    const owner = await actor(principalId)
    const row = await get('operation:' + bankOperationId(operationId)) || (UUID.test(operationId || '') ? await get('operation:' + operationId) : null)
    if (!row || row.manifestDigest !== manifestDigest || row.principalId !== principalId || digest(row.owner) !== digest(binding(owner))) fail('BANK_RETAINED_OWNER_TERMS_REQUIRED')
    return { owner, row }
  }
  async function item(tokenId, block) {
    if (!/^[1-9][0-9]*$/.test(String(tokenId))) fail('BANK_ITEM_TOKEN_REQUIRED')
    const asset = await reader.asset(String(tokenId), block)
    const backing = await store.get(manifest.worldAssets.deploymentId, 'asset:' + tokenId)
    if (Number(asset.kind) !== 1 || asset.redeemed || asset.redemptionPending || !backing || backing.kind !== 'item'
      || backing.snapshotHash !== asset.snapshotHash || backing.nativeReceiptId !== asset.nativeReceiptId) fail('BANK_QUALIFIED_NATIVE_ITEM_REQUIRED')
    return { asset, backing }
  }
  async function loanTerms(request, owner, block) {
    if (owner.walletAddress !== manifest.roles.lender) fail('BANK_LENDER_ONLY')
    const borrower = await actor(request.borrowerPrincipalId || request.borrowerId)
    if (borrower.walletAddress === owner.walletAddress) fail('BANK_DISTINCT_BORROWER_REQUIRED')
    const qualified = await item(request.tokenId, block), asset = qualified.asset
    if (asset.owner !== borrower.walletAddress) fail('BANK_COLLATERAL_OWNER_REQUIRED')
    const principal = units(request, 'principal', 6, cap('USDC')), repayment = units(request, 'repayment', 6), valuation = units(request, 'valuation', 6)
    if (principal * 10000n > valuation * 3000n || repayment < principal || repayment - principal > principal / 100n) fail('BANK_LOAN_POLICY_LIMIT_EXCEEDED')
    const terms = { borrower: borrower.walletAddress, tokenId: BigInt(asset.tokenId), ownershipNonce: BigInt(asset.ownershipNonce),
      revision: BigInt(asset.revision), snapshotHash: asset.snapshotHash, valuation, principal, repayment,
      term: boundedInteger(request.term ?? 86400, 60, 30 * 86400, 'BANK_TERM_REQUIRED'),
      grace: boundedInteger(request.grace ?? 3600, 60, 7 * 86400, 'BANK_GRACE_REQUIRED'),
      offerExpiry: boundedInteger(request.offerExpiry ?? block.timestamp + 3600, block.timestamp + 1, block.timestamp + 86400, 'BANK_OFFER_EXPIRY_REQUIRED'),
      auctionDuration: boundedInteger(request.auctionDuration ?? 3600, 60, 7 * 86400, 'BANK_AUCTION_DURATION_REQUIRED'),
      auctionReserve: units(request, 'auctionReserve', 6, valuation) }
    return { loanId: chainId(request.loanId || deployment + ':' + request.operationId), loanTerms: terms,
      borrowerPrincipalId: borrower.principalId, descriptor: qualified.backing.descriptor || null }
  }
  async function quote({ owner, tokenIn, tokenOut, amountOut, maximum }, block) {
    const inputToken = token(tokenIn), outputToken = token(tokenOut)
    if (tokenIn === tokenOut) return { tokenIn, tokenOut, amountOut, quotedInput: amountOut, maximum: maximum ?? amountOut, deadline: block.timestamp + 120 }
    const hookData = encodeAbiParameters([{ type: 'address' }], [owner.walletAddress])
    const main = name => manifest.pools[name === 'CITY' ? 'cityUsdc' : 'gemUsdc']
    let functionName, params
    if (tokenIn === 'USDC' || tokenOut === 'USDC') {
      const key = main(tokenIn === 'USDC' ? tokenOut : tokenIn)
      functionName = 'quoteExactOutputSingle'
      params = { poolKey: key, zeroForOne: inputToken.address === String(key.currency0).toLowerCase(), exactAmount: amountOut, hookData }
    } else {
      const inputPool = main(tokenIn), outputPool = main(tokenOut)
      functionName = 'quoteExactOutput'
      // The official exact-output quoter walks this path from last to first.
      params = { exactCurrency: outputToken.address, path: [
        { intermediateCurrency: inputToken.address, fee: Number(inputPool.fee), tickSpacing: Number(inputPool.tickSpacing), hooks: inputPool.hooks, hookData },
        { intermediateCurrency: manifest.usdc, fee: Number(outputPool.fee), tickSpacing: Number(outputPool.tickSpacing), hooks: outputPool.hooks, hookData }
      ], exactAmount: amountOut }
    }
    const simulation = await client.simulateContract({ address: manifest.quoter, abi: abis.quoter, functionName, args: [params], account: owner.walletAddress })
    const quotedInput = BigInt(simulation.result[0]), operatorMaximum = cap(tokenIn)
    const slippageMaximum = (quotedInput * 10100n + 9999n) / 10000n
    const ceiling = [maximum ?? slippageMaximum, slippageMaximum, operatorMaximum].reduce((a, b) => a < b ? a : b)
    if (quotedInput <= 0n || quotedInput > ceiling) fail('BANK_QUOTE_EXCEEDS_MAXIMUM')
    return { tokenIn, tokenOut, amountOut, quotedInput, maximum: ceiling, deadline: block.timestamp + 120 }
  }

  async function preview(request) {
    if (!request || typeof request.operationId !== 'string' || !request.operationId || request.operationId.length > 200) fail('BANK_OPERATION_REQUIRED')
    const id = bankOperationId(request.operationId), action = aliases[request.action] || request.action
    if (manifest.mode === 'marketplace' && !marketplaceActions.has(action)) fail('MARKETPLACE_ACTION_REQUIRED')
    return store.lock(deployment, 'bank:' + id, async () => {
      const owner = await actor(request.principalId), previous = await get('operation:' + id), inputDigest = digest(request)
      if (previous) {
        if (previous.inputDigest !== inputDigest || digest(previous.owner) !== digest(binding(owner))) fail('BANK_PREVIEW_IMMUTABLE')
        return view(previous)
      }
      await reader.verify()
      const block = await reader.snapshot()
      let terms
      if (action === 'offer') terms = await loanTerms(request, owner, block)
      else if (['borrow', 'cancel_offer', 'repay', 'auction', 'bid', 'settle', 'claim'].includes(action)) {
        if (!hex32(request.loanId)) fail('BANK_LOAN_ID_REQUIRED')
        const loan = await read('bank', 'loan', [request.loanId], block), state = Number(loan.state)
        if (!state) fail('BANK_LOAN_NOT_FOUND')
        terms = { loanId: request.loanId.toLowerCase(), loan: json(loan) }
        const borrower = lower(loan.terms.borrower) === owner.walletAddress
        if (action === 'borrow' && (!borrower || state !== 1 || block.timestamp >= Number(loan.terms.offerExpiry))) fail('BANK_LIVE_BORROWER_OFFER_REQUIRED')
        if (action === 'cancel_offer' && (state !== 1 || owner.walletAddress !== manifest.roles.lender && !borrower && block.timestamp < Number(loan.terms.offerExpiry))) fail('BANK_CANCEL_AUTHORITY_REQUIRED')
        if (action === 'repay' && (!borrower || ![2, 3].includes(state) || state === 3 && block.timestamp >= Number(loan.auctionEnd))) fail('BANK_REPAYABLE_BORROWER_LOAN_REQUIRED')
        if (action === 'auction' && (state !== 2 || block.timestamp <= Number(loan.dueAt) + Number(loan.terms.grace))) fail('BANK_OVERDUE_LOAN_REQUIRED')
        if (action === 'bid') {
          terms.amount = units(request, 'amount', 6, cap('USDC'))
          if (borrower || state !== 3 || block.timestamp >= Number(loan.auctionEnd) || terms.amount < BigInt(loan.terms.auctionReserve) || terms.amount <= BigInt(loan.highestBid)) fail('BANK_HIGHER_LIVE_BID_REQUIRED')
        }
        if (action === 'settle' && (state !== 3 || block.timestamp < Number(loan.auctionEnd))) fail('BANK_ENDED_AUCTION_REQUIRED')
        if (action === 'claim') {
          if (lower(loan.collateralClaimant) !== owner.walletAddress) fail('BANK_COLLATERAL_CLAIMANT_REQUIRED')
          terms.recipient = owner.walletAddress
        }
      } else if (action === 'withdraw') {
        const amount = await read('bank', 'credits', [owner.walletAddress], block)
        if (amount <= 0n) fail('BANK_WITHDRAWABLE_CREDIT_REQUIRED')
        terms = { amount, withdrawAll: true, recipient: owner.walletAddress }
      } else if (action === 'swap') {
        if (request.tokenIn === request.tokenOut) fail('BANK_DISTINCT_SWAP_TOKENS_REQUIRED')
        const output = token(request.tokenOut), inputToken = token(request.tokenIn)
        terms = await quote({ owner, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
          amountOut: units(request, 'amountOut', output.decimals, cap(request.tokenOut)),
          maximum: request.maxAmountIn === undefined && request.maxAmountInBaseUnits === undefined ? undefined : units(request, 'maxAmountIn', inputToken.decimals, cap(request.tokenIn)) }, block)
      } else if (action === 'checkout') {
        const qualified = await item(request.tokenId, block), asset = qualified.asset
        if (asset.owner === owner.walletAddress) fail('BANK_FOREIGN_ITEM_REQUIRED')
        const listing = await read('market', 'listings', [BigInt(request.tokenId)], block)
        const fields = Array.isArray(listing) ? listing : ['seller', 'price', 'expiry', 'ownershipNonce', 'revision', 'nonce'].map(key => listing[key])
        const [seller, price, expiry, ownershipNonce, revision, listingNonce] = fields
        if (lower(seller) !== asset.owner || BigInt(price) <= 0n || BigInt(price) > cap('CITY') || Number(expiry) <= block.timestamp
          || !await read('market', 'isListingActive', [BigInt(request.tokenId)], block)) fail('BANK_EXACT_ACTIVE_ITEM_LISTING_REQUIRED')
        const inputName = request.tokenIn || 'USDC', inputToken = token(inputName)
        const payment = await quote({ owner, tokenIn: inputName, tokenOut: 'CITY', amountOut: BigInt(price),
          maximum: request.maxAmountIn === undefined && request.maxAmountInBaseUnits === undefined ? undefined : units(request, 'maxAmountIn', inputToken.decimals, cap(inputName)) }, block)
        if (BigInt(payment.maximum) < BigInt(price) && inputName === 'CITY') fail('BANK_QUOTE_EXCEEDS_MAXIMUM')
        terms = { ...payment, checkout: { tokenId: BigInt(request.tokenId), seller: lower(seller), price: BigInt(price), listingNonce: BigInt(listingNonce),
          ownershipNonce: BigInt(ownershipNonce), revision: BigInt(revision) }, snapshotHash: asset.snapshotHash, descriptor: qualified.backing.descriptor || null }
      } else if (action === 'workfund') {
        const worker = await actor(request.workerPrincipalId || request.workerId)
        if (worker.walletAddress === owner.walletAddress) fail('BANK_DISTINCT_WORKER_REQUIRED')
        const workId = chainId(request.workId), amount = units(request, 'amount', 18, cap('CITY'))
        let termsHash = request.termsHash, acceptedQuote = null
        if (workOrders) {
          const work = await workOrders.get({ workId: request.workId, actorOwnerId: owner.principalId })
          if (work.state !== 'terms_accepted_awaiting_funding' || work.requesterOwnerId !== owner.principalId || !work.acceptedQuoteId
            || ![worker.principalId, worker.ownerPrincipalId].includes(work.targetOwnerId) || work.quote?.asset !== 'CITY'
            || BigInt(work.quote.amountBaseUnits) !== amount || work.acceptance?.digest !== work.quote.digest) fail('BANK_ACCEPTED_EXACT_WORK_QUOTE_REQUIRED')
          termsHash = '0x' + work.quote.digest
          if (request.termsHash && request.termsHash.toLowerCase() !== termsHash.toLowerCase()) fail('BANK_WORK_TERMS_CHANGED')
          acceptedQuote = { workId: work.workId, quoteId: work.acceptedQuoteId, digest: work.quote.digest }
        } else if (!owner.operatorControlled || !hex32(termsHash)) fail('BANK_ACCEPTED_WORK_QUOTE_REQUIRED')
        if (!hex32(termsHash) || Number((await read('workEscrow', 'work', [workId], block)).state) !== 0) fail('BANK_NEW_BOUND_WORK_REQUIRED')
        terms = { workId, sourceWorkId: request.workId, worker: worker.walletAddress, workerPrincipalId: worker.principalId, termsHash,
          amount, workDeadline: boundedInteger(request.workDeadline ?? block.timestamp + 3600, block.timestamp + 1, block.timestamp + 7 * 86400, 'BANK_WORK_DEADLINE_REQUIRED'),
          reviewPeriod: boundedInteger(request.reviewPeriod ?? 3600, 60, 7 * 86400, 'BANK_WORK_REVIEW_REQUIRED'), acceptedQuote }
      } else if (['workstart', 'workcomplete', 'workaccept', 'workrefund'].includes(action)) {
        const workId = chainId(request.workId), work = await read('workEscrow', 'work', [workId], block), state = Number(work.state)
        if (!state) fail('BANK_WORK_NOT_FOUND')
        const known = await get('work:' + workId)
        terms = { workId, work: json(work), sourceWorkId: known?.sourceWorkId || request.workId }
        if (['workaccept', 'workrefund'].includes(action) && lower(work.requester) !== owner.walletAddress) fail('BANK_WORK_REQUESTER_REQUIRED')
        if (action === 'workaccept' && (state !== 3 || block.timestamp >= Number(work.deadline) + Number(work.reviewPeriod))) fail('BANK_CURRENT_INSPECTED_WORK_REQUIRED')
        if (action === 'workrefund' && (![1, 2, 3].includes(state) || block.timestamp < Number(work.deadline) + (state === 3 ? Number(work.reviewPeriod) : 0))) fail('BANK_WORK_CUTOFF_REQUIRED')
        if (action === 'workstart' || action === 'workcomplete') {
          if (!inspector?.prepare || typeof inspector.authorize !== 'function' || ![lower(work.requester), lower(work.worker)].includes(owner.walletAddress)) fail('BANK_NATIVE_INSPECTION_REQUIRED')
          const proof = await inspector.authorize({ action, workId, termsHash: work.termsHash, principalId: owner.principalId, request })
          if (proof?.approved !== true || proof.workId !== workId || proof.termsHash !== work.termsHash) fail('BANK_NATIVE_INSPECTION_REQUIRED')
          if (action === 'workstart' && (state !== 1 || block.timestamp >= Number(work.deadline))) fail('BANK_FUNDED_WORK_START_REQUIRED')
          if (action === 'workcomplete' && (state !== 2 || block.timestamp >= Number(work.deadline) || !hex32(proof.resultHash))) fail('BANK_VERIFIED_WORK_RESULT_REQUIRED')
          terms.nativeProof = json(proof)
          if (action === 'workcomplete') terms.resultHash = proof.resultHash
        }
      } else fail('BANK_ACTION_UNSUPPORTED')
      await reader.unchanged(block)
      const row = json({ id, originalOperationId: request.operationId, principalId: owner.principalId, owner: binding(owner), inputDigest, manifestDigest,
        action, terms, termsDigest: digest({ deployment, action, owner: binding(owner), terms }), status: 'preview', stages: {},
        expiresAtMs: Math.min(now() + 300000, terms.deadline ? terms.deadline * 1000 : Infinity), createdAtMs: now(),
        message: 'Preview only. Review the exact testnet terms and gas before explicitly confirming.' })
      await put('operation:' + id, row)
      return view(row)
    })
  }

  async function transact(row, owner, stageName, target, functionName, args, eventName, match = {}, asInspector = false) {
    const data = encodeFunctionData({ abi: abis[target], functionName, args }), to = manifest[target]
    const signing = asInspector ? inspector : wallets, from = asInspector ? manifest.roles.inspector : owner.walletAddress
    const operationId = bankOperationId(deployment + ':' + row.id + ':' + stageName)
    let stage = row.stages[stageName]
    if (stage && (stage.data !== data || stage.to !== to || stage.from !== from)) fail('BANK_TRANSACTION_TERMS_CHANGED')
    stage ??= row.stages[stageName] = { operationId, from, to, data, target, eventName, status: 'prepared' }
    if (stage.proof) { await reader.snapshot(stage.proof); return stage.proof }
    row.status = 'pending'; row.message = 'Reconciling the retained transaction; no replacement payment is authorized.'
    await put('operation:' + row.id, row)
    const context = asInspector ? {} : { playerId: owner.principalId }
    const deadline = ['swap', 'checkout'].includes(row.action) ? row.terms.deadline
      : row.action === 'offer' ? row.terms.loanTerms.offerExpiry : row.action === 'borrow' ? row.terms.loan.terms.offerExpiry
        : row.action === 'bid' ? row.terms.loan.auctionEnd : ['workfund', 'workstart', 'workcomplete'].includes(row.action)
          ? row.terms.workDeadline || row.terms.work.deadline : row.action === 'workaccept' ? Number(row.terms.work.deadline) + Number(row.terms.work.reviewPeriod) : null
    let result
    if (deadline && now() >= Number(deadline) * 1000) {
      // An expired operation may have executed before its reply was lost.
      // Reconcile it without signing or broadcasting another stage.
      try { result = await signing.reconcile({ ...context, operationId }) } catch { result = null }
      if (!result?.transactionHash && !result?.hash) {
        row.status = 'reconciliation_required'; row.message = 'The terms expired. Reconcile the original intent before creating another operation.'
        await put('operation:' + row.id, row); return null
      }
    } else {
      const prepared = await signing.prepare({ ...context, operationId, to, data, value: 0n, limits: { maxGas: Number(manifest.maxGas), maxNativeCostWei: manifest.maxNativeCostWei } })
      stage.transactionHash = prepared.transactionHash || prepared.hash || stage.transactionHash
      await put('operation:' + row.id, row)
      await signing.broadcast({ ...context, operationId })
      result = await signing.reconcile({ ...context, operationId })
    }
    const hash = result.transactionHash || result.hash
    if (!hex32(hash)) return null
    stage.transactionHash = hash; await put('operation:' + row.id, row)
    const proof = await reader.transaction({ transactionHash: hash, from, to, data, eventName, match, abi: abis[target] })
    if (!proof.confirmed) { row.message = proof.reason; await put('operation:' + row.id, row); return null }
    stage.proof = proof; stage.status = 'confirmed'; await put('operation:' + row.id, row)
    return proof
  }
  async function confirm({ principalId, operationId, termsDigest, confirmationId }) {
    const original = await retained(principalId, operationId)
    return store.lock(deployment, 'bank:' + original.row.id, async () => {
      const { owner, row } = await retained(principalId, original.row.originalOperationId)
      if (manifest.mode === 'marketplace' && !marketplaceActions.has(row.action)) fail('MARKETPLACE_ACTION_REQUIRED')
      if (termsDigest !== row.termsDigest) fail('BANK_EXACT_TERMS_CONFIRMATION_REQUIRED')
      await reader.verify()
      if (!row.consentedAtMs) {
        if (now() >= row.expiresAtMs) fail('BANK_PREVIEW_EXPIRED')
        if (typeof confirmationId !== 'string' || !confirmationId) fail('BANK_CONFIRMATION_ID_REQUIRED')
        const approved = await authorize({ principalId, operationId: row.originalOperationId, action: row.action, termsDigest, confirmationId, owner: row.owner })
        if (approved !== true && !(approved?.approved === true && approved.principalId === principalId && approved.termsDigest === termsDigest)) fail('BANK_EXPLICIT_OWNER_APPROVAL_REQUIRED')
        row.consentedAtMs = now(); row.confirmationId = confirmationId; row.status = 'prepared'; await put('operation:' + row.id, row)
      }
      if (row.status === 'complete') { for (const stage of Object.values(row.stages)) if (stage.proof) await reader.snapshot(stage.proof); return view(row) }
      const t = row.terms, loanId = t.loanId
      const call = (stage, target, method, args, event, match, role) => transact(row, owner, stage, target, method, args, event, match, role)
      const approve = (name, spender, amount) => call(name + '-approval', name, 'approve', [spender, BigInt(amount)])
      let proof
      try {
        if (row.action === 'offer') {
          if (!await approve('usdc', manifest.bank, t.loanTerms.principal)) return view(row)
          proof = await call('offer', 'bank', 'offerLoan', [loanId, t.loanTerms], 'LoanOffered', { loanId, borrower: t.loanTerms.borrower, tokenId: t.loanTerms.tokenId, principal: t.loanTerms.principal, repayment: t.loanTerms.repayment })
        } else if (row.action === 'borrow') {
          if (!await call('nft-approval', 'registry', 'approve', [manifest.bank, BigInt(t.loan.terms.tokenId)])) return view(row)
          proof = await call('borrow', 'bank', 'takeLoan', [loanId, t.loan.termsHash], 'LoanTaken', { loanId, borrower: owner.walletAddress, tokenId: t.loan.terms.tokenId, principal: t.loan.terms.principal })
        } else if (row.action === 'repay') {
          if (!await approve('usdc', manifest.bank, t.loan.terms.repayment)) return view(row)
          proof = await call('repay', 'bank', 'repay', [loanId], 'LoanRepaid', { loanId, borrower: owner.walletAddress, repayment: t.loan.terms.repayment })
        } else if (row.action === 'bid') {
          if (!await approve('usdc', manifest.bank, t.amount)) return view(row)
          proof = await call('bid', 'bank', 'bid', [loanId, BigInt(t.amount)], 'BidPlaced', { loanId, bidder: owner.walletAddress, amount: t.amount })
        } else if (row.action === 'cancel_offer') proof = await call('cancel-offer', 'bank', 'cancelOffer', [loanId], 'OfferCancelled', { loanId })
        else if (row.action === 'auction') proof = await call('auction', 'bank', 'startAuction', [loanId], 'AuctionStarted', { loanId })
        else if (row.action === 'settle') proof = await call('settle', 'bank', 'settleAuction', [loanId], 'AuctionSettled', { loanId })
        else if (row.action === 'claim') proof = await call('claim', 'bank', 'claimCollateral', [loanId, t.recipient], 'CollateralClaimed', { loanId, claimant: owner.walletAddress, recipient: t.recipient, tokenId: t.loan.terms.tokenId })
        else if (row.action === 'withdraw') proof = await call('withdraw', 'bank', 'withdraw', [t.recipient], 'CreditWithdrawn', { owner: owner.walletAddress, recipient: t.recipient })
        else if (row.action === 'swap' || row.action === 'checkout') {
          const input = token(t.tokenIn), op = chainId(deployment + ':' + row.id)
          if (!await approve(t.tokenIn.toLowerCase(), manifest.router, t.maximum)) return view(row)
          if (row.action === 'swap') proof = await call('swap', 'router', 'swapExactOutput', [op, input.address, token(t.tokenOut).address, BigInt(t.amountOut), BigInt(t.maximum), t.deadline], 'SwapExecuted', { operationId: op, trader: owner.walletAddress, tokenIn: input.address, tokenOut: token(t.tokenOut).address, amountOut: t.amountOut })
          else {
            proof = await call('checkout', 'router', 'buyWithSwap', [op, input.address, BigInt(t.maximum), t.deadline, t.checkout], 'CheckoutPurchased',
              { operationId: op, buyer: owner.walletAddress, tokenId: t.checkout.tokenId, seller: t.checkout.seller, tokenIn: input.address, cityPrice: t.checkout.price, listingNonce: t.checkout.listingNonce,
                ownershipNonce: String(BigInt(t.checkout.ownershipNonce) + 2n) })
            if (proof) {
              const block = await reader.snapshot(proof), asset = await reader.asset(t.checkout.tokenId, block)
              if (asset.owner !== owner.walletAddress || asset.snapshotHash !== t.snapshotHash || asset.revision !== t.checkout.revision || asset.ownershipNonce !== String(BigInt(t.checkout.ownershipNonce) + 2n)) fail('BANK_CHECKOUT_FINAL_OWNER_REQUIRED')
            }
          }
          if (proof && (BigInt(proof.args.amountIn) > BigInt(t.maximum) || BigInt(proof.args.amountIn) <= 0n)) fail('BANK_RECEIPT_INPUT_CAP_REQUIRED')
        } else if (row.action === 'workfund') {
          if (workOrders && t.acceptedQuote) await workOrders.reserveFunding({ workId: t.acceptedQuote.workId, actorOwnerId: owner.principalId,
            quoteId: t.acceptedQuote.quoteId, digest: t.acceptedQuote.digest, operationId: row.id })
          if (!await approve('city', manifest.workEscrow, t.amount)) return view(row)
          proof = await call('workfund', 'workEscrow', 'fundWork', [t.workId, t.worker, t.termsHash, BigInt(t.amount), t.workDeadline, t.reviewPeriod], 'WorkFunded',
            { workId: t.workId, requester: owner.walletAddress, worker: t.worker, termsHash: t.termsHash, amount: t.amount, deadline: t.workDeadline, reviewPeriod: t.reviewPeriod })
        } else if (row.action === 'workstart' || row.action === 'workcomplete') {
          const checked = await inspector.authorize({ action: row.action, workId: t.workId, termsHash: t.work.termsHash, principalId, retainedProof: t.nativeProof })
          if (checked?.approved !== true || checked.workId !== t.workId || checked.termsHash !== t.work.termsHash || row.action === 'workcomplete' && checked.resultHash !== t.resultHash) fail('BANK_NATIVE_INSPECTION_REQUIRED')
          proof = row.action === 'workstart'
            ? await call('workstart', 'workEscrow', 'startWork', [t.workId, t.work.termsHash], 'WorkStarted', { workId: t.workId, termsHash: t.work.termsHash }, true)
            : await call('workcomplete', 'workEscrow', 'recordCompletion', [t.workId, t.work.termsHash, t.resultHash], 'WorkCompleted', { workId: t.workId, termsHash: t.work.termsHash, resultHash: t.resultHash }, true)
        } else if (row.action === 'workaccept') proof = await call('workaccept', 'workEscrow', 'acceptWork', [t.workId, t.work.termsHash, t.work.resultHash], 'WorkAccepted', { workId: t.workId, worker: t.work.worker, resultHash: t.work.resultHash, amount: t.work.amount })
        else if (row.action === 'workrefund') proof = await call('workrefund', 'workEscrow', 'refundWork', [t.workId], 'WorkRefunded', { workId: t.workId, requester: owner.walletAddress, amount: t.work.amount })
        if (!proof) return view(row)
        if (workOrders && row.action.startsWith('work')) {
          await workOrders.projectEscrow({ workId: t.sourceWorkId, actorOwnerId: owner.principalId,
            kind: { workfund: 'fund', workstart: 'start', workcomplete: 'complete', workaccept: 'accept', workrefund: 'refund' }[row.action], proof })
        }
        if (loanId) await put('loan:' + loanId, { loanId, lastProof: proof })
        if (t.workId) await put('work:' + t.workId, { workId: t.workId, sourceWorkId: t.sourceWorkId, lastProof: proof })
        row.status = 'complete'; row.message = row.action === 'claim' ? 'Collateral ownership returned. Redeem the same native item through the existing asset flow.'
          : 'Confirmed on the pinned test chain. Native delivery and work execution have separate verified receipts.'
        await put('operation:' + row.id, row)
        return view(row)
      } catch (error) {
        row.status = /TRANSACTION_REVERTED/.test(error.message) ? 'reverted' : 'reconciliation_required'
        row.message = error.message; await put('operation:' + row.id, row); throw error
      }
    })
  }
  async function loans({ principalId }) {
    const owner = await actor(principalId), block = await reader.snapshot()
    const records = (await store.list(deployment, 'bank:loan:')).slice(-100), result = []
    for (const record of records) {
      const loan = await read('bank', 'loan', [record.loanId], block)
      if (lower(loan.terms.borrower) === owner.walletAddress || owner.walletAddress === manifest.roles.lender || Number(loan.state) === 3
        || lower(loan.highestBidder) === owner.walletAddress || lower(loan.collateralClaimant) === owner.walletAddress) result.push(json({ loanId: record.loanId, ...loan, status: names[Number(loan.state)] }))
    }
    await reader.unchanged(block)
    return { loans: result, blockNumber: String(block.blockNumber), blockHash: block.blockHash }
  }
  async function history({ principalId }) {
    const owner = await actor(principalId), block = await reader.snapshot(), result = await read('bank', 'history', [owner.walletAddress], block)
    const fields = ['principalBorrowed', 'principalRepaid', 'timelyPrincipalRepaid', 'timelyLoansRepaid', 'defaults', 'badDebt', 'activePrincipal']
    const values = Array.isArray(result) ? Object.fromEntries(fields.map((field, index) => [field, result[index]])) : result
    const feePips = await read('hook', 'feeFor', [owner.walletAddress], block)
    await reader.unchanged(block)
    return json({ address: owner.walletAddress, ...values, feePips, disclosure: 'Observed wallet repayment history; not a human credit score or proof of market demand.' })
  }
  async function credits({ principalId }) {
    const owner = await actor(principalId), block = await reader.snapshot(), amount = await read('bank', 'credits', [owner.walletAddress], block)
    await reader.unchanged(block)
    return { address: owner.walletAddress, amountBaseUnits: String(amount), amount: formatUnits(amount, 6), token: 'USDC' }
  }
  async function works({ principalId }) {
    const owner = await actor(principalId), block = await reader.snapshot(), records = (await store.list(deployment, 'bank:work:')).slice(-100), result = []
    for (const record of records) {
      const work = await read('workEscrow', 'work', [record.workId], block)
      if ([lower(work.requester), lower(work.worker)].includes(owner.walletAddress)) result.push(json({ ...record, ...work, status: workNames[Number(work.state)] }))
    }
    return { works: result, blockNumber: String(block.blockNumber), blockHash: block.blockHash }
  }
  return { preview, confirm, status: async ({ principalId, operationId }) => view((await retained(principalId, operationId)).row),
    loans, listLoans: loans, history, credits, works, manifest, reader, client, abis, getManifest: () => structuredClone(manifest) }
}
