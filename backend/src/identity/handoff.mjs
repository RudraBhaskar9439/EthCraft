import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { getAddress, hashTypedData, verifyTypedData, zeroAddress } from 'viem'
import { agreementTypedData, allocationHash, scopeHash } from '../agreements/service.mjs'
import { walletLinkTypedData } from './service.mjs'

export const AGREEMENT_REVIEW_WINDOW_MS = 15 * 60 * 1000

export const HANDOFF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_handoffs (
  id uuid PRIMARY KEY, semantic_key text NOT NULL UNIQUE, token_hash text NOT NULL,
  payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved')),
  receipt jsonb
);
CREATE OR REPLACE FUNCTION protect_wallet_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HANDOFF_IMMUTABLE'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.semantic_key IS DISTINCT FROM OLD.semantic_key
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.payload IS DISTINCT FROM OLD.payload
     OR (OLD.state='approved' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'HANDOFF_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_handoff_immutability ON wallet_handoffs;
CREATE TRIGGER wallet_handoff_immutability BEFORE UPDATE OR DELETE ON wallet_handoffs
FOR EACH ROW EXECUTE FUNCTION protect_wallet_handoff();
`
const CONTRACT_FIELDS = ['jobEscrow', 'creditToken', 'kitCustody', 'procurement', 'hook', 'poolManager', 'stateRegistry']
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const copy = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const sha = value => createHash('sha256').update(value).digest('hex')
function refuse(code) { const error = new Error(code); error.code = code; throw error }
function address(value) {
  try { const result = getAddress(value).toLowerCase(); if (result !== zeroAddress) return result } catch {}
  refuse('INVALID_HANDOFF_ACCOUNT')
}
function fields(value, expected) {
  if (!value || Object.keys(value).sort().join(',') !== expected.sort().join(',')) refuse('HANDOFF_FIELDS')
}

/** Server-owned preparation only. No browser input chooses a signing schema or contract. */
export function createHandoffService({ store, agreements, identity, deployment, origin, clock = Date.now }) {
  if (!store?.transaction || !agreements?.get || deployment?.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY') refuse('VERIFIED_HANDOFF_CONTEXT_REQUIRED')
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.origin !== origin || (parsedOrigin.protocol !== 'https:' && !(parsedOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)))) refuse('INVALID_HANDOFF_ORIGIN')
  const contracts = Object.fromEntries(CONTRACT_FIELDS.map(name => [name, address(deployment[name])]))
  const fixed = copy({ serverId: deployment.serverId, bundleHash: deployment.bundleHash })
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) refuse('INVALID_HANDOFF_CLOCK'); return value }
  function assertAgreement(record) {
    if (!record || record.domain.chainId !== 1301 || address(record.domain.verifyingContract) !== contracts.jobEscrow ||
        record.domain.name !== 'AgentCityEscrow' || record.domain.version !== '1' ||
        address(record.terms.cred) !== contracts.creditToken || address(record.terms.kit) !== contracts.kitCustody ||
        record.terms.serverId !== fixed.serverId || record.terms.bundleHash !== fixed.bundleHash ||
        scopeHash(record.scope) !== record.terms.scopeHash || allocationHash(record.allocations) !== record.terms.allocationsHash ||
        hashTypedData(agreementTypedData(record)) !== record.hash) refuse('HANDOFF_DEPLOYMENT_MISMATCH')
  }
  async function save(kind, account, typedData, expiresAtMs, reference, review) {
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()) refuse('HANDOFF_EXPIRED')
    const id = randomUUID(), token = randomBytes(32).toString('hex')
    const payload = copy({ id, kind, origin, chainId: 1301, expectedAccount: address(account), contracts,
      typedData, digest: hashTypedData(typedData), createdAtMs: now(), expiresAtMs,
      reference, review, purpose: kind === 'agreement' ? 'separate_synthetic_contract_approval' : 'identity_link_only',
      syntheticContractDemoOnly: true, minecraftEconomicBridge: false })
    try {
      await store.query('INSERT INTO wallet_handoffs(id,semantic_key,token_hash,payload) VALUES($1,$2,$3,$4)',
        [id, `${kind}:${payload.digest}:${payload.expectedAccount}`, sha(token), payload])
    } catch (error) { if (error.code === '23505') refuse('HANDOFF_ALREADY_PREPARED'); throw error }
    return { id, token, urlFragment: `id=${id}&token=${token}`, digest: payload.digest, expiresAtMs }
  }
  async function prepareAgreement({ agreementHash, account }) {
    const record = await agreements.get(agreementHash)
    assertAgreement(record)
    if (BigInt(now()) >= BigInt(record.scope.approvalExpiresAtMs) || BigInt(Math.floor(now() / 1000)) >= BigInt(record.terms.workDeadline)) refuse('HANDOFF_EXPIRED')
    const signer = address(account)
    if (!['proposed', 'approved'].includes(record.state) || !record.requiredSigners.includes(signer)) refuse('HANDOFF_SIGNER_NOT_REQUIRED')
    if (record.approvals.some(row => row.signer === signer)) refuse('HANDOFF_APPROVAL_ALREADY_RECORDED')
    return save('agreement', signer, agreementTypedData(record), Math.min(now() + AGREEMENT_REVIEW_WINDOW_MS, Number(record.scope.approvalExpiresAtMs)),
      { agreementHash: record.hash }, { requester: record.terms.requester, builder: record.terms.builder, scope: record.scope,
        economicBoundary: 'Synthetic contract demonstration only; no Minecraft items, access, work rewards or payouts.',
        allocations: record.allocations, totalLaborBaseUnits: record.allocations.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(),
        materialCapBaseUnits: record.terms.materialCap, tokenDecimals: 18, workDeadline: record.terms.workDeadline,
        reviewDeadline: record.terms.reviewDeadline, passDeadline: record.terms.passDeadline, absoluteExpiry: record.terms.absoluteExpiry })
  }
  async function prepareIdentity(binding) {
    if (!identity?.issueChallenge || !identity?.linkWallet) refuse('AUTHENTICATED_IDENTITY_SERVICE_REQUIRED')
    const challenge = await identity.issueChallenge(binding)
    if (challenge.chainId !== 1301 || challenge.origin !== origin || address(challenge.wallet) !== address(binding.wallet)) refuse('HANDOFF_IDENTITY_CONTEXT_MISMATCH')
    return save('identity', challenge.wallet, walletLinkTypedData(challenge), challenge.expiresAtMs,
      { challenge: copy(challenge) }, { playerUuid: challenge.playerUuid, serverId: challenge.serverId,
        sessionId: challenge.sessionId, issuedAtMs: challenge.issuedAtMs })
  }
  async function read(tx, id, token, lock = false) {
    if (!uuid.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) refuse('HANDOFF_ACCESS_REQUIRED')
    const { rows: [row] } = await tx.query('SELECT * FROM wallet_handoffs WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])
    if (!row || !timingSafeEqual(Buffer.from(sha(token)), Buffer.from(row.token_hash))) refuse('HANDOFF_ACCESS_REQUIRED')
    const payload = row.payload
    if (payload.id !== id || payload.origin !== origin || payload.chainId !== 1301 ||
        CONTRACT_FIELDS.some(name => payload.contracts[name] !== contracts[name]) || hashTypedData(payload.typedData) !== payload.digest) refuse('HANDOFF_CHANGED')
    if (payload.kind === 'agreement') {
      const current = await agreements.get(payload.reference.agreementHash)
      assertAgreement(current)
      if (current.state === 'superseded') refuse('HANDOFF_AGREEMENT_SUPERSEDED')
      if (hashTypedData(agreementTypedData(current)) !== payload.digest || current.hash !== payload.reference.agreementHash) refuse('HANDOFF_CHANGED')
    } else if (payload.kind !== 'identity' || hashTypedData(walletLinkTypedData(payload.reference.challenge)) !== payload.digest) refuse('HANDOFF_CHANGED')
    return row
  }
  async function get(id, token) {
    const row = await read(store, id, token)
    return { ...row.payload, state: row.state === 'pending' && now() >= row.payload.expiresAtMs ? 'expired' : row.state, receipt: row.receipt }
  }
  async function submit(id, token, input) {
    fields(input, ['account', 'chainId', 'consent', 'signature'])
    if (input.consent !== true || input.chainId !== 1301) refuse('EXPLICIT_APPROVAL_AND_NETWORK_REQUIRED')
    const signer = address(input.account)
    if (typeof input.signature !== 'string' || !/^0x[a-f0-9]{130}$/i.test(input.signature)) refuse('UNSUPPORTED_SIGNATURE')
    return store.transaction(async tx => {
      const row = await read(tx, id, token, true), payload = row.payload
      if (signer !== payload.expectedAccount || !await verifyTypedData({ ...payload.typedData, address: signer, signature: input.signature })) refuse('INVALID_HANDOFF_SIGNATURE')
      if (row.state === 'approved') return row.receipt
      let appliedAt, action
      if (payload.kind === 'agreement') {
        const record = await agreements.get(payload.reference.agreementHash)
        const previous = record.approvals.find(approval => approval.signer === signer && approval.signature === input.signature)
        if (previous) appliedAt = Number(previous.approved_at_ms)
        else {
          if (now() >= payload.expiresAtMs) refuse('HANDOFF_EXPIRED')
          await agreements.approve(payload.reference.agreementHash, signer, input.signature)
          appliedAt = now()
        }
        action = 'agreement_approval_recorded'
      } else {
        const challenge = payload.reference.challenge
        const { rows: [previous] } = await tx.query('SELECT linked_at_ms FROM identity_links WHERE challenge_id=$1 AND wallet=$2 AND player_uuid=$3 AND session_id=$4 AND server_id=$5',
          [challenge.id, signer, challenge.playerUuid, challenge.sessionId, challenge.serverId])
        if (previous) appliedAt = Number(previous.linked_at_ms)
        else {
          if (now() >= payload.expiresAtMs) refuse('HANDOFF_EXPIRED')
          const linked = await identity.linkWallet({ challengeId: challenge.id, playerUuid: challenge.playerUuid, sessionId: challenge.sessionId, wallet: signer, signature: input.signature })
          appliedAt = linked.linkedAtMs
        }
        action = 'wallet_link_recorded'
      }
      const receipt = { id, action, account: signer, chainId: 1301, digest: payload.digest, approvedAtMs: appliedAt,
        transactionsSubmitted: 0, independentHumanVerified: false }
      await tx.query("UPDATE wallet_handoffs SET state='approved',receipt=$2 WHERE id=$1", [id, receipt])
      return receipt
    })
  }
  return { initialize: () => store.query(HANDOFF_SCHEMA_SQL), prepareAgreement, prepareIdentity, get, submit }
}
