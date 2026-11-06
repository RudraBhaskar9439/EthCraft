import { getAddress, hashTypedData, keccak256, stringToHex, verifyTypedData, zeroAddress } from 'viem'

const ZERO_HASH = '0x' + '00'.repeat(32)
const RECORD_TYPES = { DiscoveryRecord: [
  ['id', 'string'], ['version', 'uint64'], ['owner', 'address'], ['serverId', 'bytes32'],
  ['jobId', 'bytes32'], ['kind', 'string'], ['payloadHash', 'bytes32'], ['issuedAtMs', 'uint64'],
  ['expiresAtMs', 'uint64'], ['withdrawn', 'bool']
].map(([name, type]) => ({ name, type })) }
const INPUT_FIELDS = ['namespace', 'serverId', 'chainId', 'id', 'version', 'owner', 'jobId', 'kind', 'payload', 'issuedAtMs', 'expiresAtMs', 'withdrawn']
function refuse(code) { const error = new Error(code); error.code = code; throw error }
function exact(object, fields) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).sort().join(',') !== [...fields].sort().join(',')) refuse('DISCOVERY_FIELDS')
}
function text(value, maximum) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > maximum) refuse('DISCOVERY_TEXT')
  return value
}
function hash(value, allowZero = false) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value) || !allowZero && value.toLowerCase() === ZERO_HASH) refuse('DISCOVERY_HASH')
  return value.toLowerCase()
}
function address(value) {
  try { const result = getAddress(value).toLowerCase(); if (result === zeroAddress) refuse('DISCOVERY_OWNER'); return result } catch { refuse('DISCOVERY_OWNER') }
}
function payloadFor(kind, payload) {
  if (kind === 'profile') {
    exact(payload, ['displayName', 'service', 'blueprintHash'])
    if (payload.service !== 'calculator-v1') refuse('UNSUPPORTED_SERVICE')
    return { displayName: text(payload.displayName, 64), service: payload.service, blueprintHash: hash(payload.blueprintHash) }
  }
  if (kind === 'job') {
    exact(payload, ['agreementHash', 'blueprintHash'])
    return { agreementHash: hash(payload.agreementHash), blueprintHash: hash(payload.blueprintHash) }
  }
  if (kind === 'offer') {
    exact(payload, ['profileKey', 'agreementHash', 'blueprintHash', 'laborAmount'])
    if (typeof payload.laborAmount !== 'string' || !/^[1-9][0-9]*$/.test(payload.laborAmount) || BigInt(payload.laborAmount) >= (1n << 256n)) refuse('INVALID_OFFER_AMOUNT')
    return { profileKey: hash(payload.profileKey), agreementHash: hash(payload.agreementHash), blueprintHash: hash(payload.blueprintHash), laborAmount: payload.laborAmount }
  }
  refuse('UNSUPPORTED_DISCOVERY_KIND')
}

export function prepareDiscoveryRecord(input) {
  exact(input, INPUT_FIELDS)
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1 || !Number.isSafeInteger(input.version) || input.version < 1) refuse('DISCOVERY_CHAIN_OR_VERSION')
  if (!Number.isSafeInteger(input.issuedAtMs) || !Number.isSafeInteger(input.expiresAtMs) || input.issuedAtMs < 0 || input.expiresAtMs <= input.issuedAtMs || input.expiresAtMs - input.issuedAtMs > 86400000 || typeof input.withdrawn !== 'boolean') refuse('DISCOVERY_LIFETIME')
  const payload = payloadFor(input.kind, input.payload)
  const jobId = hash(input.jobId, input.kind === 'profile')
  if (input.kind === 'profile' && jobId !== ZERO_HASH) refuse('PROFILE_JOB_SCOPE')
  return { namespace: text(input.namespace, 128), serverId: hash(input.serverId), chainId: input.chainId,
    id: text(input.id, 128), version: input.version, owner: address(input.owner), jobId,
    kind: input.kind, payload, issuedAtMs: input.issuedAtMs, expiresAtMs: input.expiresAtMs,
    withdrawn: input.withdrawn, payloadHash: keccak256(stringToHex(JSON.stringify(payload))) }
}

export function discoveryTypedData(record) {
  return { domain: { name: 'AgentCityDiscovery', version: '1', chainId: record.chainId, salt: keccak256(stringToHex(record.namespace)) },
    types: RECORD_TYPES, primaryType: 'DiscoveryRecord',
    message: Object.fromEntries(RECORD_TYPES.DiscoveryRecord.map(({ name }) => [name, record[name]])) }
}

export function createDiscoveryService({ store, adapter, context, resolveJob, clock = Date.now }) {
  if (!store?.transaction || !adapter || typeof resolveJob !== 'function') refuse('DISCOVERY_AUTHORITIES_REQUIRED')
  const namespace = text(context.namespace, 128)
  const serverId = hash(context.serverId)
  const blueprintHash = hash(context.blueprintHash)

  async function verifyEntity(entity, { allowWithdrawn = false } = {}) {
    exact(entity.envelope, ['record', 'signature'])
    const { record, signature } = entity.envelope
    exact(record, [...INPUT_FIELDS, 'payloadHash'])
    const { payloadHash, ...input } = record
    const canonical = prepareDiscoveryRecord(input)
    if (canonical.payloadHash !== payloadHash || record.namespace !== namespace || record.serverId !== serverId || record.chainId !== context.chainId || record.payload.blueprintHash !== blueprintHash) refuse('DISCOVERY_CONTEXT_MISMATCH')
    if (address(entity.owner) !== canonical.owner) refuse('UNTRUSTED_DISCOVERY_OWNER')
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature) || !await verifyTypedData({ ...discoveryTypedData(canonical), address: canonical.owner, signature })) refuse('INVALID_DISCOVERY_SIGNATURE')
    const now = clock()
    if (!Number.isSafeInteger(now) || canonical.issuedAtMs > now || now >= canonical.expiresAtMs) refuse('DISCOVERY_EXPIRED_OR_FUTURE')
    if (!allowWithdrawn && canonical.withdrawn) refuse('DISCOVERY_WITHDRAWN')
    if (canonical.kind !== 'profile') {
      const job = await resolveJob(canonical.jobId)
      if (!job || job.agreementHash !== canonical.payload.agreementHash || job.blueprintHash !== blueprintHash) refuse('UNTRUSTED_DISCOVERY_JOB')
      if (canonical.kind === 'job' && address(job.requester) !== canonical.owner) refuse('UNTRUSTED_JOB_PUBLISHER')
    }
    return { ...entity, envelope: { record: canonical, signature }, digest: hashTypedData(discoveryTypedData(canonical)) }
  }

  async function retain(entity) {
    const record = entity.envelope.record
    return store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([namespace, record.id])])
      const current = (await tx.query('SELECT * FROM discovery_heads WHERE namespace=$1 AND record_id=$2 FOR UPDATE', [namespace, record.id])).rows[0]
      if (current && (current.owner !== record.owner || current.kind !== record.kind || current.job_id !== record.jobId)) refuse('DISCOVERY_IDENTITY_CHANGED')
      if (current && Number(current.version) === record.version && current.digest !== entity.digest) refuse('DISCOVERY_VERSION_COLLISION')
      await tx.query(`INSERT INTO discovery_records(namespace,entity_key,record_id,version,owner,kind,job_id,digest,envelope,expires_at_ms,withdrawn)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(namespace,record_id,version) DO NOTHING`,
      [namespace, entity.key, record.id, record.version, record.owner, record.kind, record.jobId, entity.digest, JSON.stringify(entity.envelope), record.expiresAtMs, record.withdrawn])
      if (!current || record.version > Number(current.version)) {
        await tx.query(`INSERT INTO discovery_heads(namespace,record_id,version,owner,kind,job_id,digest,entity_key,expires_at_ms,withdrawn)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(namespace,record_id) DO UPDATE SET
          version=EXCLUDED.version,digest=EXCLUDED.digest,entity_key=EXCLUDED.entity_key,expires_at_ms=EXCLUDED.expires_at_ms,withdrawn=EXCLUDED.withdrawn`,
        [namespace, record.id, record.version, record.owner, record.kind, record.jobId, entity.digest, entity.key, record.expiresAtMs, record.withdrawn])
      }
      return current
    })
  }

  async function publish(envelope) {
    const checked = await verifyEntity({ key: null, owner: adapter.owner, envelope }, { allowWithdrawn: true })
    const current = (await store.query('SELECT * FROM discovery_heads WHERE namespace=$1 AND record_id=$2', [namespace, checked.envelope.record.id])).rows[0]
    if (current) {
      const record = checked.envelope.record
      if (current.owner !== record.owner || current.kind !== record.kind || current.job_id !== record.jobId) refuse('DISCOVERY_IDENTITY_CHANGED')
      if (record.version < Number(current.version)) refuse('STALE_DISCOVERY_VERSION')
      if (record.version === Number(current.version)) {
        if (current.digest !== checked.digest) refuse('DISCOVERY_VERSION_COLLISION')
        return { ...await verifyEntity(await adapter.get(current.entity_key), { allowWithdrawn: true }), fixture: adapter.fixture === true }
      }
      if (record.withdrawn && record.expiresAtMs < Number(current.expires_at_ms)) refuse('WITHDRAWAL_MUST_COVER_PRIOR_LIFETIME')
    }
    if (checked.envelope.record.kind === 'offer') await verifiedProfile(checked.envelope.record)
    // One external attempt only. The caller's durable outbox reconciles unknown submission outcomes.
    const published = await adapter.publish(checked.envelope)
    const actual = await verifyEntity(await adapter.get(published.key), { allowWithdrawn: true })
    if (actual.digest !== checked.digest) refuse('PUBLISHED_RECORD_MISMATCH')
    await retain(actual)
    return { ...actual, transactionHash: published.transactionHash, fixture: adapter.fixture === true }
  }

  async function verifiedProfile(offer) {
    const profile = await verifyEntity(await adapter.get(offer.payload.profileKey))
    if (profile.envelope.record.kind !== 'profile' || profile.envelope.record.owner !== offer.owner) refuse('UNTRUSTED_OFFER_PROFILE')
    await search({ kind: 'profile', id: profile.envelope.record.id })
    const head = (await store.query('SELECT * FROM discovery_heads WHERE namespace=$1 AND record_id=$2', [namespace, profile.envelope.record.id])).rows[0]
    if (!head || head.digest !== profile.digest || head.withdrawn || clock() >= Number(head.expires_at_ms)) refuse('STALE_OR_WITHDRAWN_PROFILE')
    return profile
  }

  async function search({ kind, jobId, id } = {}) {
    const entities = await adapter.search({ namespace, serverId, kind, jobId, id })
    const candidates = [], rejected = []
    for (const entity of entities) {
      try {
        const checked = await verifyEntity(entity, { allowWithdrawn: true })
        if (checked.envelope.record.kind === 'offer') await verifiedProfile(checked.envelope.record)
        await retain(checked)
        candidates.push(checked)
      } catch (error) { rejected.push({ key: entity.key, reason: error.code || 'UNTRUSTED_DISCOVERY_RECORD' }) }
    }
    const records = []
    for (const entity of candidates) {
      const record = entity.envelope.record
      const head = (await store.query('SELECT * FROM discovery_heads WHERE namespace=$1 AND record_id=$2', [namespace, record.id])).rows[0]
      if (head.digest === entity.digest && !head.withdrawn && clock() < Number(head.expires_at_ms) && !records.some(item => item.digest === entity.digest)) records.push(entity)
    }
    return { records, rejected, fixture: adapter.fixture === true, cached: false }
  }

  async function selectOffer(entityKey, expectedJobId) {
    const selected = await verifyEntity(await adapter.get(entityKey))
    if (selected.envelope.record.kind !== 'offer' || selected.envelope.record.jobId !== expectedJobId) refuse('WRONG_SELECTED_OFFER')
    await verifiedProfile(selected.envelope.record)
    await search({ kind: 'offer', jobId: expectedJobId, id: selected.envelope.record.id })
    const head = (await store.query('SELECT * FROM discovery_heads WHERE namespace=$1 AND record_id=$2', [namespace, selected.envelope.record.id])).rows[0]
    if (!head || head.digest !== selected.digest || head.withdrawn || clock() >= Number(head.expires_at_ms)) refuse('STALE_OR_WITHDRAWN_OFFER')
    return selected
  }
  return { publish, search, selectOffer }
}
