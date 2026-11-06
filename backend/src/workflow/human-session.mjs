import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, hashTypedData } from 'viem'
import { agreementTypedData } from '../agreements/service.mjs'
import { openWalletHandoffs } from '../identity/http-runtime.mjs'
import { prepareHumanReview } from '../identity/human-review.mjs'
import { readMinecraftAuthority, verifyMinecraftSession } from '../identity/minecraft-sessions.mjs'
import { HUMAN_ACTIONS, requireHumanIdentities } from './human-demo.mjs'
import { openHumanDemoRuntime } from './human-demo-runtime.mjs'
import { createHumanDemoOperator, readSyntheticMarketHealth } from './human-demo-operator.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^0x[a-f0-9]{64}$/i
const ROLES = ['requester', 'builder']
const FIELDS = { status: [], start: [], identity: ['role'], register: [], prepare: ['action'], begin: ['operationId'], submitted: ['operationId', 'transactionHash'], reconcile: ['operationId'], rejected: ['operationId'], provision: [], advance: [], publish: [] }
const fail = code => { const error = new Error(code); error.code = code; throw error }
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const address = value => { try { const result = getAddress(value).toLowerCase(); if (!/^0x0{40}$/.test(result)) return result } catch {}; fail('HUMAN_SESSION_PARTICIPANTS_REQUIRED') }

export function validateHumanSessionInput(action, input = {}) {
  if (!Object.hasOwn(FIELDS, action) || !input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).sort().join(',') !== [...FIELDS[action]].sort().join(',')) fail('HUMAN_SESSION_ACTION_FIELDS')
  if (action === 'identity' && !ROLES.includes(input.role)) fail('HUMAN_SESSION_ROLE_REQUIRED')
  if (action === 'prepare' && !HUMAN_ACTIONS.includes(input.action)) fail('HUMAN_SESSION_TRANSACTION_ACTION_REQUIRED')
  if ('operationId' in input && (typeof input.operationId !== 'string' || !UUID.test(input.operationId))) fail('HUMAN_SESSION_OPERATION_REQUIRED')
  if ('transactionHash' in input && (typeof input.transactionHash !== 'string' || !HASH.test(input.transactionHash))) fail('HUMAN_SESSION_TRANSACTION_HASH_REQUIRED')
  return { ...input, ...('operationId' in input ? { operationId: input.operationId.toLowerCase() } : {}), ...('transactionHash' in input ? { transactionHash: input.transactionHash.toLowerCase() } : {}) }
}

export function assertHumanSessionOperation(demo, operationId) {
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('HUMAN_SESSION_OPERATION_REQUIRED')
  const matches = HUMAN_ACTIONS.filter(action => typeof demo?.operation_ids?.[action] === 'string' && demo.operation_ids[action].toLowerCase() === operationId.toLowerCase())
  if (matches.length !== 1) fail('HUMAN_SESSION_OPERATION_REQUIRED')
  return { action: matches[0], role: matches[0] === 'claim' ? 'builder' : 'requester' }
}

/** Local-operator controller. Only provision/advance/publish open operator signing roles. */
export function createHumanSessionController({ rootDirectory = ROOT, openRuntime = openHumanDemoRuntime, openHandoffs = openWalletHandoffs,
  readAuthority = readMinecraftAuthority, prepareReview = prepareHumanReview, requireIdentities = requireHumanIdentities,
  createOperator = createHumanDemoOperator, clock = Date.now } = {}) {
  const stateDirectory = path.join(rootDirectory, '.local/human-session'), activeFile = path.join(stateDirectory, 'active.json')
  let tail = Promise.resolve()
  async function privateJson(file, optional = false) {
    try {
      const info = await stat(file)
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('HUMAN_SESSION_PRIVATE_FILE_REQUIRED')
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
  }
  async function participants() {
    const configured = await privateJson(path.join(rootDirectory, '.local/human-approvals/participants.json'))
    const result = { requester: address(configured.requester), builder: address(configured.builder) }
    if (result.requester === result.builder) fail('HUMAN_SESSION_DISTINCT_PARTICIPANTS_REQUIRED')
    return result
  }
  function originFor(value) {
    let url
    try { url = new URL(value) } catch { fail('HUMAN_SESSION_LOCAL_ORIGIN_REQUIRED') }
    if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(Number(url.port)) || Number(url.port) < 1024 || Number(url.port) > 65535) fail('HUMAN_SESSION_LOCAL_ORIGIN_REQUIRED')
    return value
  }
  function validatePin(pin, people, origin) {
    if (!pin || pin.schema !== 'agentcity-human-session-v1' || !HASH.test(pin.agreementHash || '') || !/^agentcity-online-auth-[a-f0-9]{32}$/.test(pin.identityServerId || '') ||
      !/^\.local\/human-approvals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/$/.test(pin.reviewDirectory || '') || pin.origin !== origin ||
      !Number.isSafeInteger(pin.createdAtMs) || ROLES.some(role => address(pin.participants?.[role]) !== people[role])) fail('HUMAN_SESSION_PIN_CHANGED')
    return pin
  }
  async function savePin(pin) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const temporary = path.join(stateDirectory, 'active-' + randomUUID() + '.json')
    await writeFile(temporary, JSON.stringify(pin, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, activeFile)
  }
  async function agreementFor(wallet, pin, people) {
    const record = await wallet.agreements.get(pin.agreementHash)
    if (record.hash !== pin.agreementHash || hashTypedData(agreementTypedData(record)) !== pin.agreementHash || record.domain.chainId !== 1301 || ROLES.some(role => address(record.terms[role]) !== people[role])) fail('HUMAN_SESSION_AGREEMENT_CHANGED')
    return record
  }
  async function demoFor(runtime, pin) {
    const demo = (await runtime.store.query('SELECT * FROM ac_human_demos WHERE agreement_hash=$1', [pin.agreementHash])).rows[0] || null
    if (demo && demo.identity_server_id !== pin.identityServerId) fail('HUMAN_SESSION_PIN_CHANGED')
    return demo
  }
  async function identityStatus(runtime, people, pin, origin) {
    const blockers = [], roles = ROLES.map(role => ({ role, wallet: people[role], linked: false, paired: false }))
    let authority = null
    try { authority = await readAuthority() } catch { blockers.push('AUTHENTICATED_MINECRAFT_AUTHORITY_UNAVAILABLE') }
    if (authority && pin && authority.metadata.serverId !== pin.identityServerId) blockers.push('HUMAN_SESSION_IDENTITY_SERVER_CHANGED')
    const serverId = pin?.identityServerId || authority?.metadata.serverId
    for (const role of roles) {
      if (authority && authority.metadata.serverId === serverId) {
        const sessions = authority.snapshot.sessions.filter(entry => entry.wallet?.toLowerCase() === role.wallet).flatMap(entry => {
          try { return [verifyMinecraftSession({ ...authority, binding: entry, wallet: role.wallet, now: clock() })] } catch { return [] }
        })
        if (sessions.length === 1) { role.paired = true; role.name = sessions[0].name }
      }
      if (serverId) {
        const rows = (await runtime.store.query(`SELECT l.player_uuid FROM identity_links l JOIN identity_challenges c ON c.id=l.challenge_id
          WHERE l.server_id=$1 AND l.wallet=$2 AND c.server_id=l.server_id AND c.wallet=l.wallet AND c.player_uuid=l.player_uuid AND c.session_id=l.session_id
          AND c.origin=$3 AND c.chain_id=1301 AND c.consumed_at_ms=l.linked_at_ms AND c.consumed_at_ms>=c.issued_at_ms AND c.consumed_at_ms<c.expires_at_ms AND l.linked_at_ms<=$4`, [serverId, role.wallet, origin, clock()])).rows
        role.linked = rows.length === 1
      }
    }
    let ready = false
    if (authority && authority.metadata.serverId === serverId) {
      try { await requireIdentities({ store: runtime.store, serverId, ...people, beforeMs: clock(), origin }); ready = true } catch { blockers.push('TWO_VERIFIED_HUMAN_WALLET_LINKS_REQUIRED') }
    }
    return { authority, identities: { ready, roles }, blockers }
  }
  async function reviewLinks(wallet, pin, people, origin) {
    const links = []
    for (const role of ROLES) {
      const file = await privateJson(path.join(rootDirectory, pin.reviewDirectory, role + '.json'))
      let url
      try { url = new URL(file.url) } catch { fail('HUMAN_SESSION_REVIEW_CHANGED') }
      const fragment = new URLSearchParams(url.hash.slice(1))
      if (url.origin !== origin || url.pathname !== '/wallet' || file.agreementHash !== pin.agreementHash) fail('HUMAN_SESSION_REVIEW_CHANGED')
      const request = await wallet.service.get(fragment.get('id'), fragment.get('token'))
      if (file.id !== request.id || request.kind !== 'agreement' || request.reference.agreementHash !== pin.agreementHash || address(request.expectedAccount) !== people[role]) fail('HUMAN_SESSION_REVIEW_CHANGED')
      links.push({ role, wallet: people[role], url: file.url, state: request.state, expiresAtMs: request.expiresAtMs })
    }
    return { agreementHash: pin.agreementHash, expiresAtMs: Math.min(...links.map(link => link.expiresAtMs)), links }
  }
  function nextFor(identities, session, blockers) {
    if (!identities.ready) { const role = identities.roles.find(item => !item.linked); return role ? { action: 'identity', role: role.role } : { action: 'wait' } }
    if (!session) return { action: 'start' }
    if (session.complete) return { action: 'complete' }
    if (session.approvalCount < 2) return { action: 'review' }
    if (!session.registered) return { action: 'register' }
    for (const transactionAction of HUMAN_ACTIONS) {
      const intent = session.actions[transactionAction]
      if (!intent || ['confirmed', 'reverted'].includes(intent.status)) continue
      return { action: intent.status === 'prepared' ? 'begin' : intent.txHash ? 'reconcile' : 'recover', operationId: intent.operationId, transactionAction }
    }
    if (!session.actions.fund && !session.actions.buy && !session.fundingPlan?.provisioningRecorded && session.fundingPlan?.missing?.some(item => ['requester test CRED', 'builder faucet ETH'].includes(item))) return { action: 'provision' }
    if (session.fundingPlan?.missing?.includes('requester faucet ETH')) return { action: 'wait' }
    for (const transactionAction of ['approve_escrow', 'fund', 'approve_procurement', 'buy']) {
      if (session.actions[transactionAction]?.status === 'confirmed') continue
      if (transactionAction === 'buy') {
        if (!session.marketHealth) return { action: 'wait' }
        if (session.marketHealth.refreshRequired || session.marketHealth.publicationPending) return { action: 'publish' }
      }
      return { action: 'prepare', transactionAction }
    }
    if (!session.inspectionReady) return { action: 'advance' }
    for (const transactionAction of ['accept', 'claim']) if (session.actions[transactionAction]?.status !== 'confirmed') return { action: 'prepare', transactionAction }
    return { action: blockers.length ? 'wait' : 'complete' }
  }
  async function marketStatus(runtime) {
    const health = await readSyntheticMarketHealth(runtime)
    const publication = (await runtime.store.query("SELECT operation_id,status FROM ac_outbox WHERE topic='human.market.publish' AND payload->>'chainInstance'=$1 AND payload->>'registry'=$2 ORDER BY created_at DESC,operation_id DESC LIMIT 1", [`1301:${runtime.deployment.genesisHash}`, address(runtime.deployment.stateRegistry)])).rows[0]
    return { ...health, publicationPending: Boolean(publication && publication.status !== 'complete'), ...(publication ? { publication: { operationId: publication.operation_id, status: publication.status } } : {}) }
  }
  async function status(runtime, wallet, pin, people, origin) {
    const identity = await identityStatus(runtime, people, pin, origin), blockers = [...identity.blockers]
    let session = null
    if (pin) {
      let agreement = await agreementFor(wallet, pin, people)
      const demo = await demoFor(runtime, pin), actions = {}
      let fundingPlan, marketHealth
      if (demo) {
        try { await runtime.workflow.sync(pin.agreementHash); agreement = await agreementFor(wallet, pin, people) } catch { blockers.push('CHAIN_RECONCILIATION_REQUIRED') }
        for (const action of HUMAN_ACTIONS) {
          const intent = await runtime.external.get(demo.operation_ids[action], people[action === 'claim' ? 'builder' : 'requester'])
          if (intent) { const { request, ...safe } = intent; actions[action] = safe }
        }
        try {
          fundingPlan = await runtime.workflow.fundingPlan(pin.agreementHash)
          const provisioning = (await runtime.store.query('SELECT agreement_hash FROM ac_human_provisioning WHERE agreement_hash=$1', [pin.agreementHash])).rows.length > 0
          const remaining = actions.buy?.status === 'confirmed' ? 0n : actions.fund?.status === 'confirmed' ? 3000000000000000000n : 9000000000000000000n
          fundingPlan = { ...fundingPlan, requiredRemainingCred: remaining.toString(), provisioningRecorded: provisioning,
            missing: [...fundingPlan.missing.filter(item => item !== 'requester test CRED'), ...(BigInt(fundingPlan.requesterCred) < remaining ? ['requester test CRED'] : [])] }
          if (fundingPlan.missing.includes('requester faucet ETH')) blockers.push('REQUESTER_TESTNET_GAS_REQUIRED')
          if (provisioning && !actions.fund && !actions.buy && fundingPlan.missing.some(item => ['requester test CRED', 'builder faucet ETH'].includes(item))) blockers.push('TEST_PROVISIONING_RECONCILIATION_REQUIRED')
        } catch { blockers.push('TEST_RESOURCE_CHECK_UNAVAILABLE') }
        try { marketHealth = await marketStatus(runtime) } catch { blockers.push('SYNTHETIC_MARKET_HEALTH_UNAVAILABLE') }
      }
      session = { agreementHash: pin.agreementHash, agreementState: agreement.state, approvalCount: agreement.approvals.length,
        registered: Boolean(demo), actions, inspectionReady: Boolean(demo?.inspection), ...(fundingPlan ? { fundingPlan } : {}), ...(marketHealth ? { marketHealth } : {}),
        complete: Boolean(actions.claim?.status === 'confirmed' && actions.claim.canonical === true && actions.claim.confirmations >= 2) }
    }
    return { participants: people, identities: identity.identities, session, nextAction: nextFor(identity.identities, session, blockers), blockers }
  }
  async function run({ action, input = {}, origin = 'http://127.0.0.1:8789' } = {}) {
    input = validateHumanSessionInput(action, input)
    origin = originFor(origin)
    const people = await participants()
    let pin = await privateJson(activeFile, true)
    if (pin) validatePin(pin, people, origin)
    const runtime = await openRuntime({ identityServerId: pin?.identityServerId, origin })
    let wallet
    try {
      wallet = await openHandoffs(origin)
      if (action === 'status') return await status(runtime, wallet, pin, people, origin)
      if (action === 'identity') {
        const identity = await identityStatus(runtime, people, pin, origin), role = identity.identities.roles.find(item => item.role === input.role)
        if (!identity.authority || (pin && identity.authority.metadata.serverId !== pin.identityServerId)) fail('AUTHENTICATED_MINECRAFT_AUTHORITY_UNAVAILABLE')
        if (role.linked) return { role: input.role, wallet: role.wallet, linked: true }
        const paired = identity.authority.snapshot.sessions.filter(entry => entry.wallet?.toLowerCase() === role.wallet).flatMap(entry => { try { return [verifyMinecraftSession({ ...identity.authority, binding: entry, wallet: role.wallet, now: clock() })] } catch { return [] } })
        if (paired.length !== 1) fail('AUTHENTICATED_PAIRED_SESSION_REQUIRED')
        const handoff = await wallet.service.prepareIdentity(paired[0])
        return { role: input.role, wallet: role.wallet, linked: false, url: origin + '/wallet#' + handoff.urlFragment, expiresAtMs: handoff.expiresAtMs }
      }
      if (action === 'start') {
        const authority = await readAuthority()
        await requireIdentities({ store: runtime.store, serverId: authority.metadata.serverId, ...people, beforeMs: clock(), origin })
        if (pin) {
          const agreement = await agreementFor(wallet, pin, people), review = await reviewLinks(wallet, pin, people, origin)
          const hasIntent = (await runtime.store.query('SELECT operation_id FROM external_wallet_intents WHERE agreement_hash=$1 LIMIT 1', [pin.agreementHash])).rows.length > 0
          const frozen = agreement.approvals.length > 0 || hasIntent || Boolean(await demoFor(runtime, pin))
          if (!review.links.every(link => link.state === 'expired')) {
            if (authority.metadata.serverId !== pin.identityServerId) fail('HUMAN_SESSION_IDENTITY_SERVER_CHANGED')
            return { ...await status(runtime, wallet, pin, people, origin), review }
          }
          if (frozen) fail('HUMAN_SESSION_FROZEN_RECONCILIATION_REQUIRED')
        }
        const review = await prepareReview({ ...people, origin, reuseActive: false })
        const relative = path.relative(rootDirectory, review.privateDirectory).split(path.sep).join('/') + '/'
        pin = { schema: 'agentcity-human-session-v1', agreementHash: review.agreementHash, identityServerId: authority.metadata.serverId,
          participants: people, reviewDirectory: relative, origin, createdAtMs: clock(), reviewExpiresAtMs: review.expiresAtMs }
        validatePin(pin, people, origin)
        await agreementFor(wallet, pin, people)
        await savePin(pin)
        return { ...await status(runtime, wallet, pin, people, origin), review: await reviewLinks(wallet, pin, people, origin) }
      }
      if (!pin) fail('HUMAN_SESSION_START_REQUIRED')
      await agreementFor(wallet, pin, people)
      if (action === 'register') { await runtime.workflow.register(pin.agreementHash); return await status(runtime, wallet, pin, people, origin) }
      const demo = await demoFor(runtime, pin)
      if (!demo) fail('HUMAN_WORKFLOW_NOT_REGISTERED')
      if (action === 'prepare') {
        if (input.action === 'buy') {
          const health = await marketStatus(runtime)
          if (health.publicationPending) fail('SYNTHETIC_HEALTH_PUBLICATION_RECONCILIATION_REQUIRED')
          if (!health.backed || health.refreshRequired) fail('FRESH_SYNTHETIC_HEALTH_REQUIRED')
        }
        return await runtime.workflow.prepareAction(pin.agreementHash, input.action, people[input.action === 'claim' ? 'builder' : 'requester'])
      }
      if (action === 'provision' || action === 'advance' || action === 'publish') {
        const operator = createOperator(runtime, { ready: true })
        return action === 'provision' ? await operator.provisionTestResources(pin.agreementHash) : action === 'publish' ? await operator.publishHealth(pin.agreementHash) : await operator.advance(pin.agreementHash)
      }
      const bound = assertHumanSessionOperation(demo, input.operationId), actor = people[bound.role]
      if (action === 'begin') return await runtime.external.beginBroadcast(input.operationId, actor)
      if (action === 'submitted') return await runtime.external.recordSubmittedHash(input.operationId, input.transactionHash, actor)
      if (action === 'reconcile') return await runtime.external.reconcile(input.operationId, actor)
      if (action === 'rejected') return await runtime.external.retryRejectedPrompt(input.operationId, actor)
      fail('HUMAN_SESSION_ACTION_FIELDS')
    } finally { await Promise.allSettled([wallet?.close(), runtime.close()]) }
  }
  return args => { const result = tail.then(() => run(args)).then(json); tail = result.catch(() => {}); return result }
}

export const handleHumanSession = createHumanSessionController()
