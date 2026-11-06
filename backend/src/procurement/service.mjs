import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseEventLogs } from 'viem'
import { readFileSync } from 'node:fs'

const procurementAbi = JSON.parse(readFileSync(new URL('../../../contracts/abi/Procurement.json', import.meta.url)))
const kitAbi = JSON.parse(readFileSync(new URL('../../../contracts/abi/KitCustody.json', import.meta.url)))
const MAX_UINT256 = (1n << 256n) - 1n

function refuse(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function address(value) {
  try { return getAddress(value).toLowerCase() } catch { refuse('INVALID_PROCUREMENT_ADDRESS') }
}

function uint(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) refuse('UNSAFE_PROCUREMENT_INTEGER')
  if (!['string', 'bigint', 'number'].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) refuse('INVALID_PROCUREMENT_INTEGER')
  const integer = BigInt(value)
  if (integer > MAX_UINT256) refuse('PROCUREMENT_INTEGER_OVERFLOW')
  return integer
}

function hash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) refuse('INVALID_PROCUREMENT_HASH')
  return value.toLowerCase()
}

export function destinationHash(record) {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'string' }, { type: 'int32[3]' }],
    [record.terms.serverId, record.terms.jobId, record.scope.worldId, record.scope.stockChest]
  ))
}

function publicOperation(row) {
  if (!row) return null
  return {
    operation_id: row.operation_id,
    agreement_hash: row.agreement_hash,
    job_id: row.job_id,
    requester: row.requester,
    destination_hash: row.destination_hash,
    kits: row.kits,
    max_cred: row.max_cred,
    deadline: row.deadline,
    status: row.status,
    transaction_hash: row.transaction_hash,
    claim_id: row.claim_id,
    spent_cred: row.spent_cred
  }
}

export function createProcurementService({ store, evm, deployment, account, confirmations = 1, clock = Date.now }) {
  if (!store?.transaction || !evm?.prepare || !account?.address || !(deployment.chainId === 31337 || deployment.chainId === 1301 && deployment.environment === 'PUBLIC_TESTNET_SYNTHETIC_ONLY' && evm.chain?.id === 1301)) refuse('LOCAL_PROCUREMENT_CONTEXT_REQUIRED')
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) refuse('INVALID_PROCUREMENT_FINALITY')
  const requester = address(account.address)
  const route = address(deployment.procurement)
  const cred = address(deployment.creditToken)
  const kit = address(deployment.kitCustody)
  const escrow = address(deployment.jobEscrow)

  async function read(tx, operationId, locked = false) {
    const result = await tx.query('SELECT * FROM procurement_operations WHERE operation_id=$1' + (locked ? ' FOR UPDATE' : ''), [operationId])
    const row = result.rows[0] || null
    if (row && (row.requester !== requester || row.chain_instance !== evm.instance)) refuse('PROCUREMENT_OPERATION_CONTEXT')
    return row
  }

  async function totals(tx, agreementHash) {
    const result = await tx.query(`SELECT
      COALESCE(SUM(spent_cred) FILTER (WHERE status='confirmed'),0)::text AS spent,
      COALESCE(SUM(max_cred) FILTER (WHERE status NOT IN ('confirmed','reverted')),0)::text AS reserved,
      COALESCE(BOOL_OR(status='reorganized'),false) AS blocked
      FROM procurement_operations WHERE agreement_hash=$1`, [agreementHash])
    return result.rows[0]
  }

  async function prepare(input) {
    const fields = ['operationId', 'agreementHash', 'kits', 'maxCred', 'deadline']
    if (!input || Object.keys(input).sort().join(',') !== fields.sort().join(',')) refuse('PROCUREMENT_FIELDS')
    if (typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId)) refuse('INVALID_PROCUREMENT_OPERATION')
    const agreementHash = hash(input.agreementHash)
    const kits = uint(input.kits)
    const maxCred = uint(input.maxCred)
    const deadline = uint(input.deadline)
    if (kits !== 1n || maxCred === 0n || deadline > (1n << 64n) - 1n) refuse('UNSUPPORTED_PROCUREMENT_QUANTITY_OR_CAP')
    await evm.verify()
    const block = await evm.client.getBlock()

    const reserved = await store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.operationId])
      const result = await tx.query('SELECT * FROM agreement_records WHERE agreement_hash=$1 FOR UPDATE', [agreementHash])
      const record = result.rows[0]
      if (!record || record.state !== 'funded') refuse('FUNDED_AGREEMENT_REQUIRED')
      if (record.domain.chainId !== deployment.chainId || address(record.domain.verifyingContract) !== escrow ||
          address(record.terms.requester) !== requester || address(record.terms.cred) !== cred || address(record.terms.kit) !== kit ||
          hash(record.terms.serverId) !== hash(deployment.serverId) || hash(record.terms.bundleHash) !== hash(deployment.bundleHash)) refuse('PROCUREMENT_AGREEMENT_CONTEXT')
      const destination = destinationHash(record)
      const calldata = encodeFunctionData({ abi: procurementAbi, functionName: 'buyAndRedeem',
        args: [record.terms.jobId, kits, maxCred, deadline, destination] })
      const binding = keccak256(encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
        [evm.instance, agreementHash, requester, route, calldata]
      ))
      const existing = await read(tx, input.operationId)
      if (existing) {
        if (existing.call_binding !== binding) refuse('PROCUREMENT_OPERATION_CONFLICT')
        return existing
      }
      if (deadline <= block.timestamp || deadline > block.timestamp + 60n || deadline > BigInt(record.terms.workDeadline)) refuse('PROCUREMENT_QUOTE_EXPIRED')
      const budget = await totals(tx, agreementHash)
      if (budget.blocked) refuse('PROCUREMENT_RECONCILIATION_REQUIRED')
      if (BigInt(budget.spent) + BigInt(budget.reserved) + maxCred > BigInt(record.terms.materialCap)) refuse('MATERIAL_CAP_EXCEEDED')
      const now = clock()
      const inserted = await tx.query(`INSERT INTO procurement_operations
        (operation_id,agreement_hash,job_id,requester,chain_instance,destination_hash,kits,max_cred,deadline,calldata,call_binding,status,created_at_ms,updated_at_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$12) RETURNING *`,
      [input.operationId, agreementHash, record.terms.jobId, requester, evm.instance, destination,
        kits.toString(), maxCred.toString(), deadline.toString(), calldata, binding, now])
      return inserted.rows[0]
    })
    if (reserved.status !== 'reserved') return publicOperation(reserved)
    // A prepare failure leaves the durable cap reservation intact until its outcome is known.
    const intent = await evm.prepare(input.operationId, account, route, reserved.calldata)
    await store.query("UPDATE procurement_operations SET status='prepared',transaction_hash=$2,updated_at_ms=$3 WHERE operation_id=$1 AND status='reserved'",
      [input.operationId, intent.transaction_hash, clock()])
    return publicOperation(await read(store, input.operationId))
  }

  async function broadcast(operationId) {
    const row = await read(store, operationId)
    if (!row || row.chain_instance !== evm.instance) refuse('PROCUREMENT_OPERATION_NOT_FOUND')
    if (['confirmed', 'reverted'].includes(row.status)) return publicOperation(row)
    if (['reserved', 'reorganized'].includes(row.status)) refuse('PROCUREMENT_NOT_PREPARED_OR_REORGANIZED')
    if ((await totals(store, row.agreement_hash)).blocked) refuse('PROCUREMENT_RECONCILIATION_REQUIRED')
    const result = await evm.broadcast(operationId)
    if (!['submitted', 'unknown'].includes(result.status) || result.hash !== row.transaction_hash) refuse('PROCUREMENT_SEND_BINDING')
    await store.query("UPDATE procurement_operations SET status=$2,updated_at_ms=$3 WHERE operation_id=$1 AND status NOT IN ('confirmed','reverted','reorganized')",
      [operationId, result.status, clock()])
    return publicOperation(await read(store, operationId))
  }

  async function reconcile(operationId) {
    const row = await read(store, operationId)
    if (!row || row.chain_instance !== evm.instance) refuse('PROCUREMENT_OPERATION_NOT_FOUND')
    if (row.status === 'reserved') return publicOperation(row)
    const outcome = await evm.receipt(operationId, confirmations)
    if (outcome.hash !== row.transaction_hash) refuse('PROCUREMENT_RECEIPT_BINDING')
    let purchased
    if (outcome.status === 'confirmed') {
      const events = parseEventLogs({ abi: procurementAbi, logs: outcome.receipt.logs.filter(log => address(log.address) === route), eventName: 'Purchased', strict: true })
      if (events.length !== 1) refuse('PURCHASE_EVENT_REQUIRED')
      purchased = events[0].args
      if (hash(purchased.jobId) !== hash(row.job_id) || address(purchased.requester) !== row.requester || purchased.kits !== BigInt(row.kits) ||
          purchased.spentCred <= 0n || purchased.spentCred > BigInt(row.max_cred)) refuse('PURCHASE_EVENT_BINDING')
      const claims = parseEventLogs({ abi: kitAbi, logs: outcome.receipt.logs.filter(log => address(log.address) === kit), eventName: 'ClaimCreated', strict: true })
      if (claims.length !== 1 || hash(claims[0].args.claimId) !== hash(purchased.claimId) || hash(claims[0].args.jobId) !== hash(row.job_id) ||
          address(claims[0].args.recipient) !== row.requester || claims[0].args.kits !== BigInt(row.kits) || hash(claims[0].args.destinationHash) !== row.destination_hash) refuse('PURCHASE_CLAIM_BINDING')
    }
    return store.transaction(async tx => {
      await tx.query('SELECT agreement_hash FROM agreement_records WHERE agreement_hash=$1 FOR UPDATE', [row.agreement_hash])
      const current = await read(tx, operationId, true)
      if (purchased) {
        await tx.query("UPDATE procurement_operations SET status='confirmed',spent_cred=$2,claim_id=$3,receipt=$4,updated_at_ms=$5 WHERE operation_id=$1",
          [operationId, purchased.spentCred.toString(), purchased.claimId, JSON.stringify(outcome.receipt, (_, value) => typeof value === 'bigint' ? value.toString() : value), clock()])
      } else if (outcome.status === 'reverted') {
        await tx.query("UPDATE procurement_operations SET status='reverted',updated_at_ms=$2 WHERE operation_id=$1", [operationId, clock()])
      } else if (['pending', 'confirming', 'reorganized'].includes(outcome.status)) {
        const next = current.status === 'confirmed' ? 'reorganized' : outcome.status
        await tx.query('UPDATE procurement_operations SET status=$2,updated_at_ms=$3 WHERE operation_id=$1', [operationId, next, clock()])
      } else refuse('UNKNOWN_PROCUREMENT_RECEIPT_STATE')
      return publicOperation(await read(tx, operationId))
    })
  }

  async function budget(agreementHash) {
    const result = await store.query('SELECT terms FROM agreement_records WHERE agreement_hash=$1', [hash(agreementHash)])
    if (!result.rows[0]) refuse('FUNDED_AGREEMENT_REQUIRED')
    if (address(result.rows[0].terms.requester) !== requester) refuse('PROCUREMENT_AGREEMENT_CONTEXT')
    const total = await totals(store, agreementHash)
    const cap = BigInt(result.rows[0].terms.materialCap)
    return { cap: cap.toString(), spent: total.spent, reserved: total.reserved,
      available: (cap - BigInt(total.spent) - BigInt(total.reserved)).toString(), blocked: total.blocked }
  }

  return { prepare, broadcast, reconcile, get: async operationId => publicOperation(await read(store, operationId)), budget }
}
