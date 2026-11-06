import { readFileSync } from 'node:fs'
import { encodeFunctionData, getAddress, hashTypedData, keccak256, parseEventLogs, stringToHex, toHex, verifyTypedData, zeroHash } from 'viem'
import { agreementTypedData, allocationHash, scopeHash } from '../agreements/service.mjs'
import { INSPECTION_TYPES } from '../inspection/coordinator.mjs'
import { destinationHash } from '../procurement/service.mjs'

const abi = Object.fromEntries(['CreditToken', 'JobEscrow', 'Procurement', 'KitCustody', 'StateRegistry'].map(name => [name, JSON.parse(readFileSync(new URL(`../../../contracts/abi/${name}.json`, import.meta.url)))]))
const ACTIONS = ['approve_escrow', 'fund', 'approve_procurement', 'buy', 'accept', 'claim', 'refund']
const MAX_LABOR = 6n * 10n ** 18n, MAX_MATERIAL = 3n * 10n ** 18n, MAX_NATIVE = 8000000000000000n
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
function refuse(code) { const error = new Error(code); error.code = code; throw error }
function address(value) { try { const result = getAddress(value).toLowerCase(); if (/^0x0{40}$/.test(result)) refuse('EXTERNAL_ZERO_ADDRESS'); return result } catch { refuse('EXTERNAL_INVALID_ADDRESS') } }
function hash(value) { if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) refuse('EXTERNAL_INVALID_HASH'); return value.toLowerCase() }
function uuid(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) refuse('EXTERNAL_INVALID_OPERATION'); return value }
function uint(value) { if (!['string', 'number', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) refuse('EXTERNAL_INVALID_INTEGER'); const n = BigInt(value); if (n >= 1n << 256n) refuse('EXTERNAL_INTEGER_OVERFLOW'); return n }
function same(left, right) { return String(left).toLowerCase() === String(right).toLowerCase() }

// Read-only RPC plus durable unsigned intents. This module never signs or broadcasts transactions.
export function createExternalWalletService({ store, client, deployment, resolveContext, onPrepared, clock = Date.now }) {
  if (!store?.transaction || !client || client.chain?.id !== 1301 || deployment?.chainId !== 1301 ||
      deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY' || deployment.rpcUrl !== 'https://sepolia.unichain.org' || typeof resolveContext !== 'function') refuse('EXTERNAL_TESTNET_CONTEXT_REQUIRED')
  const genesis = hash(deployment.genesisHash), instance = `1301:${genesis}`
  const cred = address(deployment.creditToken), escrow = address(deployment.jobEscrow), procurement = address(deployment.procurement), kit = address(deployment.kitCustody)
  const terminal = status => ['confirmed', 'reverted'].includes(status)
  const read = async (tx, id, actor, locked = false) => {
    const row = (await tx.query('SELECT * FROM external_wallet_intents WHERE operation_id=$1' + (locked ? ' FOR UPDATE' : ''), [uuid(id)])).rows[0] || null
    if (row && (row.chain_instance !== instance || row.sender !== address(actor))) refuse('EXTERNAL_INTENT_AUTHORITY')
    return row
  }
  async function verifyChain() {
    if (await client.getChainId() !== 1301 || !same((await client.getBlock({ blockNumber: 0n })).hash, genesis)) refuse('EXTERNAL_CHAIN_CHANGED')
  }
  const contract = (target, name, method, args = []) => client.readContract({ address: target, abi: abi[name], functionName: method, args })
  function visible(row) {
    if (!row) return null
    return { operationId: row.operation_id, agreementHash: row.agreement_hash, action: row.action, status: row.status,
      chainId: 1301, sender: row.sender, nonce: String(row.nonce), deadline: String(row.deadline), deadlineMs: Number(row.deadline) * 1000, nativeBudgetWei: row.summary.nativeBudgetWei,
      request: row.status === 'prepared' && uint(row.deadline) > BigInt(Math.floor(clock() / 1000)) ? row.request : null,
      summary: row.summary, txHash: row.transaction_hash, receiptBlockNumber: row.receipt_block_number && String(row.receipt_block_number),
      receiptBlockHash: row.receipt_block_hash, confirmations: row.confirmations, canonical: row.canonical,
      evidence: row.evidence, failureCode: row.failure_code }
  }
  async function canonicalAgreement(record) {
    if (!record || !['approved', 'funded'].includes(record.state) || !record.hash || !record.domain || !record.terms || !record.scope || !Array.isArray(record.allocations) || !Array.isArray(record.approvals)) refuse('EXTERNAL_APPROVED_AGREEMENT_REQUIRED')
    const t = record.terms
    if (record.domain.name !== 'AgentCityEscrow' || record.domain.version !== '1' || record.domain.chainId !== 1301 || address(record.domain.verifyingContract) !== escrow ||
        address(t.cred) !== cred || address(t.kit) !== kit || hash(t.serverId) !== hash(deployment.serverId) || hash(t.bundleHash) !== hash(deployment.bundleHash) ||
        !record.scope.worldId?.startsWith('synthetic-human-demo-') || address(t.requester) === address(t.builder) ||
        hash(t.scopeHash) !== scopeHash(record.scope) || hash(t.allocationsHash) !== allocationHash(record.allocations) || hash(record.hash) !== hashTypedData(agreementTypedData(record))) refuse('EXTERNAL_AGREEMENT_BINDING')
    const labor = record.allocations.reduce((sum, row) => sum + uint(row.amount), 0n)
    if (labor <= 0n || labor > MAX_LABOR || uint(t.materialCap) <= 0n || uint(t.materialCap) > MAX_MATERIAL || uint(record.scope.nativeGasBudgetWei) <= 0n) refuse('EXTERNAL_AGREEMENT_CAP')
    const required = [...new Set([address(t.requester), address(t.builder), ...record.allocations.map(row => address(row.recipient))])]
    for (const signer of required) {
      const approval = record.approvals.find(row => address(row.signer) === signer)
      if (!approval || !await verifyTypedData({ ...agreementTypedData(record), address: signer, signature: approval.signature })) refuse('EXTERNAL_AGREEMENT_SIGNATURE')
    }
    return { labor, nativeBudget: uint(record.scope.nativeGasBudgetWei) < MAX_NATIVE ? uint(record.scope.nativeGasBudgetWei) : MAX_NATIVE }
  }
  async function typedAction(action, actor, context, now) {
    const record = context.agreement, t = record.terms
    const { labor, nativeBudget } = await canonicalAgreement(record)
    const expectedActor = action === 'claim' ? address(t.builder) : address(t.requester)
    if (actor !== expectedActor) refuse('EXTERNAL_ACTION_ROLE')
    const expected = { jobId: hash(t.jobId), agreementHash: hash(record.hash), requester: address(t.requester), builder: address(t.builder), labor: labor.toString(), materialCap: uint(t.materialCap).toString() }
    let target = escrow, name = 'JobEscrow', method, args, amount = 0n, deadline = now + 300n, maxCred = 0n
    const status = await contract(escrow, 'JobEscrow', 'status', [t.jobId])
    const funded = same(status[0], record.hash) && uint(status[1]) === labor
    if (['approve_escrow', 'fund'].includes(action)) {
      if (record.state !== 'approved' || status[0] !== zeroHash || now >= uint(t.workDeadline)) refuse('EXTERNAL_FUNDING_STAGE')
      deadline = deadline < uint(t.workDeadline) ? deadline : uint(t.workDeadline)
      if (action === 'approve_escrow') { target = cred; name = 'CreditToken'; method = 'approve'; amount = labor; args = [escrow, labor]; expected.spender = escrow }
      else {
        amount = labor
        if (uint(await contract(cred, 'CreditToken', 'allowance', [actor, escrow])) < labor) refuse('EXTERNAL_ESCROW_ALLOWANCE_REQUIRED')
        method = 'fund'; args = [t, record.allocations.map(row => row.recipient), record.allocations.map(row => uint(row.amount)), record.approvals.find(row => same(row.signer, t.requester)).signature, record.approvals.find(row => same(row.signer, t.builder)).signature]
      }
    } else {
      if (record.state !== 'funded' || !funded) refuse('EXTERNAL_CANONICAL_FUNDING_REQUIRED')
      if (action === 'approve_procurement' || action === 'buy') {
        if (status[2] || status[3] || now >= uint(t.workDeadline)) refuse('EXTERNAL_PROCUREMENT_STAGE')
        deadline = deadline < uint(t.workDeadline) ? deadline : uint(t.workDeadline)
        if (action === 'approve_procurement') { target = cred; name = 'CreditToken'; method = 'approve'; amount = uint(t.materialCap); args = [procurement, amount]; expected.spender = procurement }
        else {
          const quote = context.quote
          if (!quote || uint(quote.kits) !== 1n) refuse('EXTERNAL_FIXED_QUOTE_REQUIRED')
          maxCred = uint(quote.maxCred); deadline = uint(quote.deadline)
          if (maxCred <= 0n || maxCred > uint(t.materialCap) || deadline <= now || deadline > now + 60n || deadline > uint(t.workDeadline)) refuse('EXTERNAL_QUOTE_BOUNDARY')
          if (uint(await contract(cred, 'CreditToken', 'allowance', [actor, procurement])) < maxCred) refuse('EXTERNAL_PROCUREMENT_ALLOWANCE_REQUIRED')
          if (await contract(kit, 'KitCustody', 'backed') !== true || await contract(address(deployment.stateRegistry), 'StateRegistry', 'available') !== true) refuse('EXTERNAL_MARKET_UNAVAILABLE')
          target = procurement; name = 'Procurement'; method = 'buyAndRedeem'; expected.destinationHash = destinationHash(record); expected.kits = '1'; expected.maxCred = maxCred.toString()
          args = [t.jobId, 1n, maxCred, deadline, expected.destinationHash]
        }
      } else if (action === 'accept') {
        const inspection = context.inspection, report = inspection?.report
        if (typeof onPrepared !== 'function' || inspection?.protected !== true || !report || status[2] || status[3] || now >= uint(t.reviewDeadline) || now >= uint(t.absoluteExpiry)) refuse('EXTERNAL_PROTECTED_INSPECTION_REQUIRED')
        if (!same(report.jobId, t.jobId) || !same(report.agreementHash, record.hash) || !same(report.blueprintHash, t.blueprintHash) || !same(report.testsHash, t.testsHash) || report.passed !== true || uint(report.casesPassed) !== 16n || uint(report.casesTotal) !== 16n || hash(report.lockHash) === zeroHash || hash(report.reportHash) === zeroHash || uint(report.completedAt) > now || uint(report.completedAt) >= uint(t.workDeadline) || uint(report.validUntil) <= now || uint(report.validUntil) > uint(t.passDeadline)) refuse('EXTERNAL_INSPECTION_BINDING')
        const typed = { domain: record.domain, types: INSPECTION_TYPES, primaryType: 'Inspection', message: report }
        if (!await verifyTypedData({ ...typed, address: address(deployment.attestor), signature: inspection.signature }) || await contract(escrow, 'JobEscrow', 'invalidReports', [hashTypedData(typed)])) refuse('EXTERNAL_INSPECTION_SIGNATURE')
        method = 'accept'; args = [t.jobId, report, inspection.signature]; expected.reportHash = hash(report.reportHash); expected.revision = uint(report.revision).toString(); expected.lockHash = hash(report.lockHash)
        deadline = deadline < uint(report.validUntil) ? deadline : uint(report.validUntil)
      } else if (action === 'claim') {
        amount = uint(record.allocations.find(row => same(row.recipient, actor))?.amount || 0)
        if (!status[2] || status[3] || amount <= 0n || uint(await contract(escrow, 'JobEscrow', 'allocations', [t.jobId, actor])) !== amount) refuse('EXTERNAL_CLAIM_NOT_AVAILABLE')
        method = 'claim'; args = [t.jobId]
      } else if (action === 'refund') {
        if (status[2] || status[3] || now < uint(t.absoluteExpiry)) refuse('EXTERNAL_REFUND_NOT_AVAILABLE')
        method = 'refund'; args = [t.jobId]; amount = labor
      }
    }
    expected.amount = amount.toString()
    return { target, data: encodeFunctionData({ abi: abi[name], functionName: method, args }), expected: json(expected), deadline, maxCred, nativeBudget,
      summary: { action, synthetic: true, agreementHash: record.hash, jobId: t.jobId, amount: amount.toString(), maxCred: maxCred.toString(), kits: action === 'buy' ? '1' : '0', token: 'CRED', destination: target, nativeBudgetWei: nativeBudget.toString() } }
  }
  async function prepare(input, actorWallet) {
    if (!input || Object.keys(input).sort().join(',') !== 'action,agreementHash,operationId' || !ACTIONS.includes(input.action)) refuse('EXTERNAL_ACTION_FIELDS')
    const id = uuid(input.operationId), agreementHash = hash(input.agreementHash), actor = address(actorWallet)
    await verifyChain()
    const existing = await read(store, id, actor)
    if (existing) { if (existing.agreement_hash !== agreementHash || existing.action !== input.action) refuse('EXTERNAL_OPERATION_CONFLICT'); return visible(existing) }
    // Resolve before sender/intent locks; canonical prerequisite reconciliation must not self-deadlock.
    const context = await store.transaction(tx => resolveContext({ agreementHash, action: input.action, actor, tx }))
    if (!context?.agreement || hash(context.agreement.hash) !== agreementHash) refuse('EXTERNAL_CONTEXT_REQUIRED')
    const now = (await client.getBlock()).timestamp
    const action = await typedAction(input.action, actor, context, now)
    const nonce = await client.getTransactionCount({ address: actor, blockTag: 'pending' })
    if (!Number.isSafeInteger(nonce) || nonce < 0) refuse('EXTERNAL_INVALID_NONCE')
    const estimate = uint(await client.estimateGas({ account: actor, to: action.target, data: action.data, value: 0n }))
    const gas = (estimate * 120n + 99n) / 100n
    const fees = await client.estimateFeesPerGas({ type: 'eip1559' })
    const maxFee = uint(fees.maxFeePerGas), priority = uint(fees.maxPriorityFeePerGas)
    if (gas <= 0n || gas > 2000000n || maxFee <= 0n || priority > maxFee) refuse('EXTERNAL_GAS_BOUNDARY')
    const reserve = gas * maxFee
    if (reserve > action.nativeBudget || uint(await client.getBalance({ address: actor, blockTag: 'pending' })) < reserve) refuse('EXTERNAL_NATIVE_BUDGET')
    return store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['external-wallet:' + instance + ':' + actor])
      const agreement = (await tx.query('SELECT * FROM agreement_records WHERE agreement_hash=$1 FOR UPDATE', [agreementHash])).rows[0]
      if (!agreement || agreement.state !== context.agreement.state || hashTypedData(agreementTypedData({ domain: agreement.domain, terms: agreement.terms })) !== agreementHash) refuse('EXTERNAL_AGREEMENT_CHANGED')
      const repeated = await read(tx, id, actor, true)
      if (repeated) { if (repeated.agreement_hash !== agreementHash || repeated.action !== input.action) refuse('EXTERNAL_OPERATION_CONFLICT'); return visible(repeated) }
      const rows = (await tx.query('SELECT * FROM external_wallet_intents WHERE agreement_hash=$1 OR (chain_instance=$2 AND sender=$3) FOR UPDATE', [agreementHash, instance, actor])).rows
      if (rows.some(row => row.agreement_hash === agreementHash && ['reorganized', 'reconciliation_required'].includes(row.status))) refuse('EXTERNAL_RECONCILIATION_REQUIRED')
      if (rows.some(row => row.agreement_hash === agreementHash && row.action === input.action && row.status !== 'reverted')) refuse('EXTERNAL_SEMANTIC_OPERATION_EXISTS')
      if (rows.some(row => row.sender === actor && row.chain_instance === instance && (!terminal(row.status) || Number(row.nonce) === nonce))) refuse('EXTERNAL_SENDER_RECONCILIATION_REQUIRED')
      const sameAgreement = rows.filter(row => row.agreement_hash === agreementHash)
      const native = sameAgreement.reduce((sum, row) => sum + uint(terminal(row.status) ? row.native_spent || 0 : row.native_reserved), 0n)
      const material = sameAgreement.filter(row => row.action === 'buy').reduce((sum, row) => sum + uint(row.status === 'confirmed' ? row.spent_cred : row.status === 'reverted' ? 0 : row.max_cred), 0n)
      if (native + reserve > action.nativeBudget || material + action.maxCred > uint(context.agreement.terms.materialCap)) refuse('EXTERNAL_AGGREGATE_BUDGET')
      if ((await client.getBlock()).timestamp >= action.deadline) refuse('EXTERNAL_INTENT_EXPIRED')
      if (await client.getTransactionCount({ address: actor, blockTag: 'pending' }) !== nonce) refuse('EXTERNAL_NONCE_CHANGED')
      const request = { chainId: 1301, from: actor, to: action.target, data: action.data, value: '0x0', nonce: toHex(nonce), gas: toHex(gas), maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(priority) }
      const binding = keccak256(stringToHex(JSON.stringify(json({ instance, agreementHash, action: input.action, request, deadline: action.deadline, expected: action.expected }))))
      const row = (await tx.query(`INSERT INTO external_wallet_intents(operation_id,chain_instance,agreement_hash,action,sender,nonce,destination,calldata,value,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,native_reserved,max_cred,deadline,expected,request,summary,binding,created_at_ms,updated_at_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING *`,
      [id, instance, agreementHash, input.action, actor, nonce, action.target, action.data, gas.toString(), maxFee.toString(), priority.toString(), reserve.toString(), action.maxCred.toString(), action.deadline.toString(), json(action.expected), request, action.summary, binding, clock()])).rows[0]
      if (onPrepared) await onPrepared({ agreementHash, action: input.action, operationId: id, tx, intent: visible(row) })
      return visible(row)
    })
  }
  async function failure(id, code, status = 'reconciliation_required') {
    await store.query('UPDATE external_wallet_intents SET status=$2,failure_code=$3,canonical=false,updated_at_ms=$4 WHERE operation_id=$1', [id, status, code, clock()])
  }
  function transactionMatches(row, transaction) {
    try { return Boolean(transaction && transaction.chainId === 1301 && same(transaction.hash, row.transaction_hash) && same(transaction.from, row.sender) && same(transaction.to, row.destination) &&
      same(transaction.input, row.calldata) && uint(transaction.value) === 0n && Number(transaction.nonce) === Number(row.nonce) && uint(transaction.gas) <= uint(row.gas_limit) && uint(transaction.gas) > 0n &&
      transaction.maxFeePerGas !== undefined && uint(transaction.maxFeePerGas) <= uint(row.max_fee_per_gas) && uint(transaction.maxPriorityFeePerGas) <= uint(row.max_priority_fee_per_gas)) } catch { return false }
  }
  function confirmedEvents(row, receipt) {
    const expected = row.expected
    const one = (target, name, event) => {
      const logs = parseEventLogs({ abi: abi[name], logs: receipt.logs.filter(log => same(log.address, target)), eventName: event, strict: true })
      if (logs.length !== 1) refuse('EXTERNAL_REQUIRED_EVENT')
      return json(logs[0].args)
    }
    const events = {}, evidence = { events }
    if (row.action.startsWith('approve_')) {
      const event = events.approval = one(cred, 'CreditToken', 'Approval')
      if (!same(event.owner, row.sender) || !same(event.spender, expected.spender) || uint(event.value) !== uint(expected.amount)) refuse('EXTERNAL_APPROVAL_EVENT')
    } else if (row.action === 'fund') {
      const event = events.funded = one(escrow, 'JobEscrow', 'Funded')
      if (!same(event.jobId, expected.jobId) || !same(event.agreementHash, row.agreement_hash) || !same(event.requester, row.sender) || uint(event.total) !== uint(expected.labor)) refuse('EXTERNAL_FUNDING_EVENT')
      evidence.amount = event.total
    } else if (row.action === 'buy') {
      const event = events.purchased = one(procurement, 'Procurement', 'Purchased'), claim = events.claimCreated = one(kit, 'KitCustody', 'ClaimCreated')
      if (!same(event.jobId, expected.jobId) || !same(event.requester, row.sender) || uint(event.kits) !== 1n || uint(event.spentCred) <= 0n || uint(event.spentCred) > uint(row.max_cred) ||
          !same(claim.claimId, event.claimId) || !same(claim.jobId, expected.jobId) || !same(claim.recipient, row.sender) || uint(claim.kits) !== 1n || !same(claim.destinationHash, expected.destinationHash)) refuse('EXTERNAL_PURCHASE_EVENT')
      evidence.claimId = event.claimId; evidence.spentCred = event.spentCred
    } else if (row.action === 'accept') {
      const event = events.accepted = one(escrow, 'JobEscrow', 'Accepted')
      if (!same(event.jobId, expected.jobId) || !same(event.reportHash, expected.reportHash) || uint(event.revision) !== uint(expected.revision)) refuse('EXTERNAL_ACCEPTANCE_EVENT')
    } else {
      const name = row.action === 'claim' ? 'Claimed' : 'Refunded', key = row.action === 'claim' ? 'claimed' : 'refunded'
      const event = events[key] = one(escrow, 'JobEscrow', name)
      if (!same(event.jobId, expected.jobId) || !same(event.recipient || event.requester, row.sender) || uint(event.amount) !== uint(expected.amount)) refuse('EXTERNAL_SETTLEMENT_EVENT')
      evidence.amount = event.amount
    }
    return evidence
  }
  async function reconcile(operationId, actorWallet) {
    const id = uuid(operationId), actor = address(actorWallet)
    let row = await read(store, id, actor)
    if (!row) return null
    await verifyChain()
    if (!row.transaction_hash) return visible(row)
    const transaction = await client.getTransaction({ hash: row.transaction_hash }).catch(error => { if (error.name === 'TransactionNotFoundError') return null; throw error })
    if (!transaction) { if (terminal(row.status)) await failure(id, 'EXTERNAL_CANONICAL_TRANSACTION_MISSING', 'reorganized'); return visible(await read(store, id, actor)) }
    if (!transactionMatches(row, transaction)) { await failure(id, 'EXTERNAL_TRANSACTION_MISMATCH'); refuse('EXTERNAL_TRANSACTION_MISMATCH') }
    const receipt = await client.getTransactionReceipt({ hash: row.transaction_hash }).catch(error => { if (error.name === 'TransactionReceiptNotFoundError') return null; throw error })
    if (!receipt) { if (terminal(row.status)) await failure(id, 'EXTERNAL_CANONICAL_RECEIPT_MISSING', 'reorganized'); return visible(await read(store, id, actor)) }
    if (!same(receipt.transactionHash, row.transaction_hash) || !same(receipt.from, row.sender) || !same(receipt.to, row.destination)) { await failure(id, 'EXTERNAL_RECEIPT_MISMATCH'); refuse('EXTERNAL_RECEIPT_MISMATCH') }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber })
    if (!same(block.hash, receipt.blockHash)) { await failure(id, 'EXTERNAL_NONCANONICAL_RECEIPT', 'reorganized'); return visible(await read(store, id, actor)) }
    const confirmations = Number((await client.getBlockNumber({ cacheTime: 0 })) - receipt.blockNumber + 1n)
    if (confirmations < 2) { await store.query("UPDATE external_wallet_intents SET status='confirming',confirmations=$2,canonical=false,updated_at_ms=$3 WHERE operation_id=$1", [id, Math.max(confirmations, 0), clock()]); return visible(await read(store, id, actor)) }
    let evidence = null
    if (receipt.status === 'success') {
      try { evidence = confirmedEvents(row, receipt) } catch (error) { await failure(id, error.code || 'EXTERNAL_EVENT_MISMATCH'); throw error }
    } else if (receipt.status !== 'reverted') { await failure(id, 'EXTERNAL_RECEIPT_STATUS'); refuse('EXTERNAL_RECEIPT_STATUS') }
    const nativeSpent = uint(receipt.gasUsed) * uint(receipt.effectiveGasPrice)
    if (nativeSpent > uint(row.native_reserved)) { await failure(id, 'EXTERNAL_NATIVE_RECEIPT_CAP'); refuse('EXTERNAL_NATIVE_RECEIPT_CAP') }
    const status = receipt.status === 'success' ? 'confirmed' : 'reverted'
    await store.query(`UPDATE external_wallet_intents SET status=$2,receipt=$3,evidence=$4,receipt_block_number=$5,receipt_block_hash=$6,confirmations=$7,canonical=true,native_spent=$8,spent_cred=$9,failure_code=NULL,updated_at_ms=$10 WHERE operation_id=$1`,
      [id, status, json(receipt), evidence, receipt.blockNumber.toString(), receipt.blockHash, confirmations, nativeSpent.toString(), evidence?.spentCred || null, clock()])
    return visible(await read(store, id, actor))
  }
  async function beginBroadcast(operationId, actorWallet) {
    const id = uuid(operationId), actor = address(actorWallet)
    await verifyChain()
    return store.transaction(async tx => {
      const row = await read(tx, id, actor, true)
      if (!row) refuse('EXTERNAL_INTENT_NOT_FOUND')
      if (row.status !== 'prepared' || row.transaction_hash) refuse('EXTERNAL_BROADCAST_ALREADY_STARTED')
      if (uint(row.deadline) <= (await client.getBlock()).timestamp || Number(row.deadline) * 1000 <= clock()) refuse('EXTERNAL_INTENT_EXPIRED')
      if (await client.getTransactionCount({ address: actor, blockTag: 'pending' }) !== Number(row.nonce)) refuse('EXTERNAL_NONCE_CHANGED')
      const updated = (await tx.query("UPDATE external_wallet_intents SET status='unknown',updated_at_ms=$2 WHERE operation_id=$1 RETURNING *", [id, clock()])).rows[0]
      // Commit uncertainty before the caller opens the wallet. Ordinary reads hide the request while its outcome is unknown.
      return { ...visible(updated), request: updated.request }
    })
  }
  async function retryRejectedPrompt(operationId, actorWallet) {
    const id = uuid(operationId), actor = address(actorWallet)
    await verifyChain()
    return store.transaction(async tx => {
      const row = await read(tx, id, actor, true)
      if (!row) refuse('EXTERNAL_INTENT_NOT_FOUND')
      if (row.status !== 'unknown' || row.transaction_hash) refuse('EXTERNAL_RETRY_NOT_AVAILABLE')
      if (uint(row.deadline) <= (await client.getBlock()).timestamp || Number(row.deadline) * 1000 <= clock()) refuse('EXTERNAL_INTENT_EXPIRED')
      const latest = await client.getTransactionCount({ address: actor, blockTag: 'latest' })
      const pending = await client.getTransactionCount({ address: actor, blockTag: 'pending' })
      if (latest !== Number(row.nonce) || pending !== Number(row.nonce)) refuse('EXTERNAL_NONCE_CHANGED')
      // A claimed 4001 can only reopen this exact nonce/calldata/fees; no fresh intent or reservation is created.
      const updated = (await tx.query("UPDATE external_wallet_intents SET status='prepared',updated_at_ms=$2 WHERE operation_id=$1 RETURNING *", [id, clock()])).rows[0]
      return visible(updated)
    })
  }
  async function recordSubmittedHash(operationId, transactionHash, actorWallet) {
    const id = uuid(operationId), actor = address(actorWallet)
    await store.transaction(async tx => {
      const row = await read(tx, id, actor, true)
      if (!row) refuse('EXTERNAL_INTENT_NOT_FOUND')
      if (['reorganized', 'reconciliation_required'].includes(row.status)) refuse('EXTERNAL_RECONCILIATION_REQUIRED')
      if (transactionHash == null) {
        if (!terminal(row.status)) await tx.query("UPDATE external_wallet_intents SET status='unknown',updated_at_ms=$2 WHERE operation_id=$1", [id, clock()])
      } else {
        const transaction = hash(transactionHash)
        if (row.transaction_hash && row.transaction_hash !== transaction) refuse('EXTERNAL_TRANSACTION_HASH_CHANGED')
        if (!row.transaction_hash) await tx.query("UPDATE external_wallet_intents SET transaction_hash=$2,status='submitted',updated_at_ms=$3 WHERE operation_id=$1", [id, transaction, clock()])
      }
    })
    return reconcile(id, actor)
  }
  return { prepare, beginBroadcast, retryRejectedPrompt, recordSubmittedHash, reconcile, get: async (id, actor) => visible(await read(store, id, address(actor))) }
}
