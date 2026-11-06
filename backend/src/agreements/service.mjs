import { encodeAbiParameters, getAddress, hashTypedData, keccak256, verifyTypedData, zeroAddress } from 'viem'

export const AGREEMENT_TYPES = {
  Agreement: [
    ['jobId', 'bytes32'], ['serverId', 'bytes32'], ['version', 'uint256'],
    ['requester', 'address'], ['builder', 'address'], ['cred', 'address'], ['kit', 'address'],
    ['bundleHash', 'bytes32'], ['blueprintHash', 'bytes32'], ['testsHash', 'bytes32'],
    ['accessHash', 'bytes32'], ['scopeHash', 'bytes32'], ['materialCap', 'uint256'],
    ['allocationsHash', 'bytes32'], ['workDeadline', 'uint64'], ['reviewDeadline', 'uint64'],
    ['passDeadline', 'uint64'], ['absoluteExpiry', 'uint64']
  ].map(([name, type]) => ({ name, type }))
}
const UINT256_MAX = (1n << 256n) - 1n
const UINT64_MAX = (1n << 64n) - 1n
const DERIVED_FIELDS = new Set(['scopeHash', 'allocationsHash'])

function refuse(code) { const error = new Error(code); error.code = code; throw error }
function exactFields(object, fields) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).sort().join(',') !== [...fields].sort().join(',')) refuse('AGREEMENT_FIELDS')
}
function uint(value, bits = 256) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) refuse('UNSAFE_INTEGER')
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) refuse('INVALID_UNSIGNED_INTEGER')
  const integer = BigInt(value)
  if (integer > (bits === 64 ? UINT64_MAX : UINT256_MAX)) refuse('INTEGER_OVERFLOW')
  return integer.toString()
}
function bytes32(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/.test(value)) refuse('INVALID_NONZERO_HASH')
  return value.toLowerCase()
}
function address(value) {
  let normalized
  try { normalized = getAddress(value).toLowerCase() } catch { refuse('INVALID_ADDRESS') }
  if (normalized === zeroAddress) refuse('ZERO_ADDRESS')
  return normalized
}
function coordinate(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) refuse('INVALID_COORDINATE')
  return [...value]
}

export function allocationHash(allocations) {
  return keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }],
    [allocations.map(row => row.recipient), allocations.map(row => BigInt(row.amount))]))
}

export function scopeHash(scope) {
  return keccak256(encodeAbiParameters([
    { type: 'string' }, { type: 'int32[3]' }, { type: 'int32[3]' }, { type: 'int32[3]' }, { type: 'int32[3]' },
    { type: 'string' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes32' },
    { type: 'uint256' }, { type: 'uint256' }
  ], [scope.worldId, scope.plotMin, scope.plotMax, scope.blueprintOrigin, scope.stockChest, scope.orientation,
    BigInt(scope.startAt), BigInt(scope.approvalExpiresAtMs), scope.ownershipPolicyHash, scope.refundPolicyHash,
    BigInt(scope.inferenceBudgetMicrousd), BigInt(scope.nativeGasBudgetWei)]))
}

export function agreementTypedData(record) {
  return { domain: record.domain, types: AGREEMENT_TYPES, primaryType: 'Agreement', message: record.terms }
}

export function prepareAgreement({ domain, terms, scope, allocations }) {
  exactFields(domain, ['chainId', 'verifyingContract'])
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId < 1) refuse('INVALID_CHAIN')
  const canonicalDomain = { name: 'AgentCityEscrow', version: '1', chainId: domain.chainId, verifyingContract: address(domain.verifyingContract) }
  exactFields(terms, AGREEMENT_TYPES.Agreement.filter(field => !DERIVED_FIELDS.has(field.name)).map(field => field.name))
  const canonicalTerms = {}
  for (const { name, type } of AGREEMENT_TYPES.Agreement) {
    if (DERIVED_FIELDS.has(name)) continue
    canonicalTerms[name] = type === 'bytes32' ? bytes32(terms[name]) : type === 'address' ? address(terms[name]) : uint(terms[name], type === 'uint64' ? 64 : 256)
  }
  if (canonicalTerms.requester === canonicalTerms.builder || canonicalTerms.cred === canonicalTerms.kit || canonicalTerms.version === '0') refuse('INVALID_PARTIES_OR_VERSION')
  exactFields(scope, ['worldId', 'plotMin', 'plotMax', 'blueprintOrigin', 'stockChest', 'orientation', 'startAt', 'approvalExpiresAtMs', 'ownershipPolicyHash', 'refundPolicyHash', 'inferenceBudgetMicrousd', 'nativeGasBudgetWei'])
  if (typeof scope.worldId !== 'string' || !scope.worldId.length || Buffer.byteLength(scope.worldId) > 128 || scope.orientation !== 'identity') refuse('UNSUPPORTED_SCOPE')
  const canonicalScope = {
    worldId: scope.worldId, plotMin: coordinate(scope.plotMin), plotMax: coordinate(scope.plotMax),
    blueprintOrigin: coordinate(scope.blueprintOrigin), stockChest: coordinate(scope.stockChest), orientation: scope.orientation,
    startAt: uint(scope.startAt, 64), approvalExpiresAtMs: uint(scope.approvalExpiresAtMs, 64),
    ownershipPolicyHash: bytes32(scope.ownershipPolicyHash), refundPolicyHash: bytes32(scope.refundPolicyHash),
    inferenceBudgetMicrousd: uint(scope.inferenceBudgetMicrousd), nativeGasBudgetWei: uint(scope.nativeGasBudgetWei)
  }
  for (let axis = 0; axis < 3; axis++) {
    if (canonicalScope.plotMax[axis] - canonicalScope.plotMin[axis] !== [31, 15, 15][axis] ||
        canonicalScope.blueprintOrigin[axis] !== canonicalScope.plotMin[axis] + [4, 1, 4][axis] ||
        canonicalScope.stockChest[axis] < canonicalScope.plotMin[axis] || canonicalScope.stockChest[axis] > canonicalScope.plotMax[axis]) refuse('UNSUPPORTED_PLOT')
  }
  if (BigInt(canonicalTerms.workDeadline) !== BigInt(canonicalScope.startAt) + 3600n ||
      BigInt(canonicalTerms.reviewDeadline) !== BigInt(canonicalTerms.workDeadline) + 900n ||
      canonicalTerms.absoluteExpiry !== canonicalTerms.reviewDeadline ||
      BigInt(canonicalTerms.passDeadline) > BigInt(canonicalTerms.reviewDeadline) ||
      BigInt(canonicalTerms.passDeadline) <= BigInt(canonicalTerms.workDeadline) ||
      BigInt(canonicalScope.approvalExpiresAtMs) > BigInt(canonicalTerms.workDeadline) * 1000n) refuse('INVALID_FIXED_DEADLINES')
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 8) refuse('INVALID_ALLOCATIONS')
  const canonicalAllocations = allocations.map(row => {
    exactFields(row, ['recipient', 'amount'])
    const result = { recipient: address(row.recipient), amount: uint(row.amount) }
    if (result.amount === '0') refuse('ZERO_ALLOCATION')
    return result
  })
  if (new Set(canonicalAllocations.map(row => row.recipient)).size !== canonicalAllocations.length ||
      !canonicalAllocations.some(row => row.recipient === canonicalTerms.builder) ||
      canonicalAllocations.reduce((sum, row) => sum + BigInt(row.amount), 0n) > UINT256_MAX) refuse('INVALID_ALLOCATION_RECIPIENTS_OR_TOTAL')
  canonicalTerms.scopeHash = scopeHash(canonicalScope)
  canonicalTerms.allocationsHash = allocationHash(canonicalAllocations)
  const record = { domain: canonicalDomain, terms: canonicalTerms, scope: canonicalScope, allocations: canonicalAllocations,
    requiredSigners: [...new Set([canonicalTerms.requester, canonicalTerms.builder, ...canonicalAllocations.map(row => row.recipient)])] }
  record.hash = hashTypedData(agreementTypedData(record))
  return record
}

function publicRecord(row, approvals = []) {
  return row ? { hash: row.agreement_hash, domain: row.domain, terms: row.terms, scope: row.scope,
    allocations: row.allocations, requiredSigners: row.required_signers, state: row.state,
    approvals, fundingEvidence: row.funding_evidence } : null
}

export function createAgreementService({ store, context, clock = Date.now, verifyFunding }) {
  if (!store?.transaction || !context?.domain) refuse('SUPPORTED_AGREEMENT_CONTEXT_REQUIRED')
  function supported(input) {
    exactFields(input, ['terms', 'scope', 'allocations'])
    const record = prepareAgreement({ ...input, domain: context.domain })
    for (const field of ['serverId', 'blueprintHash', 'testsHash', 'accessHash', 'bundleHash', 'cred', 'kit']) {
      const expected = field === 'cred' || field === 'kit' ? address(context[field]) : bytes32(context[field])
      if (record.terms[field] !== expected) refuse('UNSUPPORTED_AGREEMENT_' + field)
    }
    return record
  }
  function live(record) {
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0 || BigInt(now) >= BigInt(record.scope.approvalExpiresAtMs) || BigInt(Math.floor(now / 1000)) >= BigInt(record.terms.workDeadline)) refuse('AGREEMENT_APPROVAL_EXPIRED')
  }
  async function read(tx, hash, locked = false) {
    const { rows } = await tx.query('SELECT * FROM agreement_records WHERE agreement_hash=$1' + (locked ? ' FOR UPDATE' : ''), [hash])
    if (!rows[0]) refuse('AGREEMENT_NOT_FOUND')
    const approvals = await tx.query('SELECT signer,signature,approved_at_ms FROM agreement_approvals WHERE agreement_hash=$1 ORDER BY signer', [hash])
    return publicRecord(rows[0], approvals.rows)
  }
  async function insert(tx, record) {
    await tx.query(`INSERT INTO agreement_records(agreement_hash,job_id,version,domain,terms,scope,allocations,required_signers,state,created_at_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9)`,
    [record.hash, record.terms.jobId, record.terms.version, JSON.stringify(record.domain), JSON.stringify(record.terms), JSON.stringify(record.scope), JSON.stringify(record.allocations), JSON.stringify(record.requiredSigners), clock()])
  }
  async function create(input, actor) {
    const record = supported(input)
    if (address(actor) !== record.terms.requester) refuse('REQUESTER_REQUIRED')
    live(record)
    return store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [record.terms.jobId])
      const existing = await tx.query('SELECT agreement_hash FROM agreement_records WHERE job_id=$1', [record.terms.jobId])
      if (existing.rows.length) {
        if (existing.rows.some(row => row.agreement_hash === record.hash)) return read(tx, record.hash)
        refuse('AGREEMENT_EXISTS_USE_NEW_VERSION')
      }
      await insert(tx, record)
      return read(tx, record.hash)
    })
  }
  async function approve(hash, signer, signature) {
    bytes32(hash)
    const owner = address(signer)
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) refuse('UNSUPPORTED_SIGNATURE')
    return store.transaction(async tx => {
      const record = await read(tx, hash, true)
      if (!['proposed', 'approved'].includes(record.state)) refuse('AGREEMENT_NOT_APPROVABLE')
      live(record)
      if (!record.requiredSigners.includes(owner) || !await verifyTypedData({ ...agreementTypedData(record), address: owner, signature })) refuse('INVALID_AGREEMENT_APPROVAL')
      await tx.query('INSERT INTO agreement_approvals(agreement_hash,signer,signature,approved_at_ms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [hash, owner, signature, clock()])
      const approved = await read(tx, hash)
      if (record.requiredSigners.every(wallet => approved.approvals.some(row => row.signer === wallet))) await tx.query("UPDATE agreement_records SET state='approved' WHERE agreement_hash=$1", [hash])
      return read(tx, hash)
    })
  }
  async function replaceUnfunded(hash, input, actor) {
    const replacement = supported(input)
    live(replacement)
    return store.transaction(async tx => {
      const old = await read(tx, hash, true)
      if (old.state === 'funded') refuse('FUNDED_TERMS_IMMUTABLE')
      if (!['proposed', 'approved'].includes(old.state)) refuse('STALE_AGREEMENT')
      if (address(actor) !== old.terms.requester || replacement.terms.requester !== old.terms.requester) refuse('REQUESTER_REQUIRED')
      if (replacement.terms.jobId !== old.terms.jobId || BigInt(replacement.terms.version) !== BigInt(old.terms.version) + 1n) refuse('INVALID_SUCCESSOR_VERSION')
      await tx.query("UPDATE agreement_records SET state='superseded' WHERE agreement_hash=$1", [hash])
      await insert(tx, replacement)
      return read(tx, replacement.hash)
    })
  }
  async function freezeFunded(hash, evidence) {
    if (typeof verifyFunding !== 'function') refuse('VERIFIED_FUNDING_REQUIRED')
    return store.transaction(async tx => {
      const record = await read(tx, hash, true)
      if (record.state === 'funded') {
        if (!await verifyFunding({ record, evidence })) refuse('FUNDING_NOT_VERIFIED')
        return record
      }
      if (record.state !== 'approved') refuse('ALL_APPROVALS_REQUIRED')
      live(record)
      if (!await verifyFunding({ record, evidence })) refuse('FUNDING_NOT_VERIFIED')
      await tx.query("UPDATE agreement_records SET state='funded',funded_at_ms=$2,funding_evidence=$3 WHERE agreement_hash=$1", [hash, clock(), JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value)])
      return read(tx, hash)
    })
  }
  return { create, approve, replaceUnfunded, freezeFunded, get: hash => read(store, hash) }
}
