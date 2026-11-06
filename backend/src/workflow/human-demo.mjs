import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getAddress } from 'viem'
import { WorkflowRepository } from './repository.mjs'
import { SyntheticInventory } from '../delivery/synthetic-inventory.mjs'
import { SyntheticWorld } from '../inspection/synthetic-world.mjs'
import { InspectionCoordinator, INSPECTION_TYPES } from '../inspection/coordinator.mjs'
import { DecisionService } from '../inference/decision-service.mjs'
import { localOllama } from '../inference/providers.mjs'
import { destinationHash } from '../procurement/service.mjs'

const root = new URL('../../../', import.meta.url)
const abi = async name => JSON.parse(await readFile(new URL(`contracts/abi/${name}.json`, root), 'utf8'))
export const HUMAN_ACTIONS = ['approve_escrow', 'fund', 'approve_procurement', 'buy', 'accept', 'claim', 'refund']
export const HUMAN_LABOR = '6000000000000000000'
export const HUMAN_MATERIAL_CAP = '3000000000000000000'
const address = value => getAddress(value).toLowerCase()
const fail = code => { throw new Error(code) }
const asJson = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const final = result => result?.status === 'confirmed' && result.canonical === true && result.confirmations >= 2 && result.chainId === 1301

/** Historical proof of an authenticated login and wallet signature, never a current web login. */
export async function requireHumanIdentities({ store, serverId, requester, builder, beforeMs = Date.now(), origin = 'http://127.0.0.1:8789' }) {
  if (!/^agentcity-online-auth-[a-f0-9]{32}$/.test(serverId || '') || address(requester) === address(builder)) fail('TWO_AUTHENTICATED_HUMAN_IDENTITIES_REQUIRED')
  const identities = {}
  for (const [role, wallet] of Object.entries({ requester, builder })) {
    const { rows: [row] } = await store.query(`SELECT l.*,c.origin,c.chain_id,c.wallet AS challenge_wallet,
      c.server_id AS challenge_server,c.player_uuid AS challenge_player,c.session_id AS challenge_session,
      c.consumed_at_ms,c.issued_at_ms,c.expires_at_ms
      FROM identity_links l JOIN identity_challenges c ON c.id=l.challenge_id
      WHERE l.server_id=$1 AND l.wallet=$2`, [serverId, address(wallet)])
    if (!row || row.challenge_wallet !== row.wallet || row.challenge_server !== row.server_id || row.challenge_player !== row.player_uuid ||
        row.challenge_session !== row.session_id || row.origin !== origin || Number(row.chain_id) !== 1301 ||
        row.consumed_at_ms === null || Number(row.consumed_at_ms) !== Number(row.linked_at_ms) ||
        Number(row.consumed_at_ms) < Number(row.issued_at_ms) || Number(row.consumed_at_ms) >= Number(row.expires_at_ms) ||
        Number(row.linked_at_ms) > beforeMs) fail('VERIFIED_WALLETLINK_BEFORE_AGREEMENT_REQUIRED')
    identities[role] = { serverId, playerUuid: row.player_uuid, wallet: row.wallet, sessionId: row.session_id,
      challengeId: row.challenge_id, linkedAtMs: Number(row.linked_at_ms), source: 'historical_online_minecraft_walletlink' }
  }
  if (identities.requester.playerUuid === identities.builder.playerUuid) fail('DISTINCT_AUTHENTICATED_PLAYERS_REQUIRED')
  return identities
}

async function readAgreement(tx, hash) {
  const { rows: [record] } = await tx.query('SELECT * FROM agreement_records WHERE agreement_hash=$1', [hash])
  if (!record) fail('HUMAN_AGREEMENT_REQUIRED')
  const { rows: approvals } = await tx.query('SELECT signer,signature,approved_at_ms FROM agreement_approvals WHERE agreement_hash=$1 ORDER BY signer', [hash])
  return { hash: record.agreement_hash, domain: record.domain, terms: record.terms, scope: record.scope, allocations: record.allocations,
    requiredSigners: record.required_signers, approvals, state: record.state, createdAtMs: Number(record.created_at_ms) }
}

function requireTerms(agreement, deployment) {
  const { terms, scope } = agreement
  if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY' || agreement.domain.chainId !== 1301 ||
      address(agreement.domain.verifyingContract) !== address(deployment.jobEscrow) || address(terms.cred) !== address(deployment.creditToken) ||
      address(terms.kit) !== address(deployment.kitCustody) || terms.bundleHash !== deployment.bundleHash || terms.serverId !== deployment.serverId ||
      !scope.worldId.startsWith('synthetic-human-demo-') || terms.materialCap !== HUMAN_MATERIAL_CAP || agreement.allocations.length !== 1 ||
      address(agreement.allocations[0].recipient) !== address(terms.builder) || agreement.allocations[0].amount !== HUMAN_LABOR ||
      BigInt(terms.workDeadline) !== BigInt(scope.startAt) + 3600n || BigInt(terms.reviewDeadline) !== BigInt(scope.startAt) + 4500n ||
      terms.passDeadline !== terms.reviewDeadline || terms.absoluteExpiry !== terms.reviewDeadline || scope.inferenceBudgetMicrousd !== '0') fail('FIXED_HUMAN_DEMO_TERMS_REQUIRED')
  if (!['approved', 'funded'].includes(agreement.state) || [terms.requester, terms.builder].some(wallet => !agreement.approvals.some(row => address(row.signer) === address(wallet)))) fail('BOTH_HUMAN_AGREEMENT_APPROVALS_REQUIRED')
}

/** No human private keys, signing or broadcasting are accepted by this service. */
export function createHumanDemoWorkflow({ store, client, deployment, external, identityServerId, origin = 'http://127.0.0.1:8789', clock = Date.now }) {
  if (!store?.transaction || !client?.getChainId || !external?.get || !external?.reconcile) fail('DURABLE_HUMAN_WORKFLOW_REQUIRED')
  const repository = new WorkflowRepository(store)
  async function chain() {
    if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY' || await client.getChainId() !== 1301) fail('UNICHAIN_SEPOLIA_REQUIRED')
    return `1301:${(await client.getBlock({ blockNumber: 0n })).hash}`
  }
  async function read(hash, tx = store) {
    const { rows: [demo] } = await tx.query('SELECT * FROM ac_human_demos WHERE agreement_hash=$1', [hash])
    if (!demo) fail('HUMAN_WORKFLOW_NOT_REGISTERED')
    return demo
  }
  async function context(hash, tx = store) {
    const demo = await read(hash, tx), agreement = await readAgreement(tx, hash)
    requireTerms(agreement, deployment)
    if (demo.chain_instance !== await chain()) fail('HUMAN_CHAIN_INSTANCE_CHANGED')
    return { demo, agreement }
  }
  const walletFor = (agreement, action) => action === 'claim' ? agreement.terms.builder : agreement.terms.requester
  async function result(demo, agreement, action, reconcile = false) {
    const operationId = demo.operation_ids[action], wallet = walletFor(agreement, action)
    const known = await external.get(operationId, wallet)
    return known && reconcile && (known.txHash || known.status !== 'prepared') ? external.reconcile(operationId, wallet) : known
  }
  async function confirmed(demo, agreement, action) {
    const evidence = await result(demo, agreement, action, true)
    if (!final(evidence) || evidence.operationId !== demo.operation_ids[action] || evidence.agreementHash !== agreement.hash || evidence.action !== action || address(evidence.sender) !== address(walletFor(agreement, action))) fail('CONFIRMED_' + action.toUpperCase() + '_REQUIRED')
    return evidence
  }
  async function register(agreementHash) {
    const agreement = await readAgreement(store, agreementHash)
    requireTerms(agreement, deployment)
    const existing = (await store.query('SELECT * FROM ac_human_demos WHERE agreement_hash=$1', [agreementHash])).rows[0]
    if (existing) { await context(agreementHash); return existing }
    const identities = await requireHumanIdentities({ store, serverId: identityServerId, requester: agreement.terms.requester,
      builder: agreement.terms.builder, beforeMs: agreement.createdAtMs, origin })
    const instance = await chain(), jobId = randomUUID(), builderActorId = randomUUID()
    const operations = Object.fromEntries([...HUMAN_ACTIONS, 'deliver', 'acknowledge_delivery', 'publish'].map(action => [action, randomUUID()]))
    return store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [agreementHash])
      const prior = (await tx.query('SELECT * FROM ac_human_demos WHERE agreement_hash=$1', [agreementHash])).rows[0]
      if (prior) return prior
      await tx.query("INSERT INTO ac_jobs(id,agreement_digest,state,payload) VALUES($1,$2,'human_wallet_demo',$3)", [jobId, agreementHash,
        { chainJobId: agreement.terms.jobId, chainInstance: instance, requester: agreement.terms.requester, kitAddress: deployment.kitCustody, builderActorId, syntheticOnly: true }])
      await tx.query('INSERT INTO ac_inference_budgets(job_id,max_attempts,max_actions) VALUES($1,5,2)', [jobId])
      return (await tx.query('INSERT INTO ac_human_demos(agreement_hash,job_id,chain_instance,identity_server_id,identities,operation_ids,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [agreementHash, jobId, instance, identityServerId, identities, operations, clock()])).rows[0]
    })
  }
  async function resolveContext({ agreementHash, action, actor, tx = store }) {
    if (!HUMAN_ACTIONS.includes(action)) fail('UNSUPPORTED_HUMAN_ACTION')
    const { demo, agreement } = await context(agreementHash, tx)
    if (address(actor) !== address(walletFor(agreement, action))) fail('HUMAN_ACTION_ROLE_REQUIRED')
    if (action === 'fund') await confirmed(demo, agreement, 'approve_escrow')
    if (['approve_procurement', 'buy', 'accept', 'claim', 'refund'].includes(action)) await confirmed(demo, agreement, 'fund')
    if (action === 'buy') await confirmed(demo, agreement, 'approve_procurement')
    const answer = { agreement }
    if (action === 'buy') {
      if (!demo.quote) fail('HUMAN_PURCHASE_QUOTE_REQUIRED')
      answer.quote = demo.quote
    }
    if (action === 'accept') {
      await confirmed(demo, agreement, 'buy')
      const { rows: [world] } = await tx.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])
      const inspection = demo.inspection
      if (!inspection || !world?.lock_hash || inspection.report.lockHash !== world.lock_hash || inspection.report.reportHash !== world.report?.reportHash ||
          inspection.report.agreementHash !== agreement.hash || inspection.report.jobId !== agreement.terms.jobId ||
          !world.build_operation || BigInt(inspection.report.validUntil) <= (await client.getBlock()).timestamp) fail('PROTECTED_SYNTHETIC_INSPECTION_REQUIRED')
      answer.inspection = { ...inspection, protected: true }
    }
    if (action === 'claim') await confirmed(demo, agreement, 'accept')
    return answer
  }
  async function prepareAction(agreementHash, action, actor) {
    const { demo, agreement } = await context(agreementHash)
    if (!HUMAN_ACTIONS.includes(action)) fail('UNSUPPORTED_HUMAN_ACTION')
    if (address(actor) !== address(walletFor(agreement, action))) fail('HUMAN_ACTION_ROLE_REQUIRED')
    if (action === 'buy') {
      await confirmed(demo, agreement, 'fund')
      await confirmed(demo, agreement, 'approve_procurement')
      if (!demo.quote) {
        const now = (await client.getBlock()).timestamp, deadline = now + 60n < BigInt(agreement.terms.workDeadline) ? now + 60n : BigInt(agreement.terms.workDeadline)
        if (deadline <= now) fail('HUMAN_PURCHASE_DEADLINE_EXPIRED')
        await store.query('UPDATE ac_human_demos SET quote=COALESCE(quote,$2) WHERE agreement_hash=$1', [agreementHash, { kits: '1', maxCred: HUMAN_MATERIAL_CAP, deadline: String(deadline) }])
      }
    }
    return external.prepare({ agreementHash, action, operationId: demo.operation_ids[action] }, actor)
  }
  async function onPrepared({ agreementHash, action, operationId, tx }) {
    const demo = await read(agreementHash, tx)
    if (operationId !== demo.operation_ids[action]) fail('STABLE_HUMAN_OPERATION_REQUIRED')
    if (action !== 'accept') return
    const inspection = demo.inspection
    if (!inspection || BigInt(inspection.report.validUntil) <= (await client.getBlock()).timestamp) fail('PROTECTED_SYNTHETIC_INSPECTION_REQUIRED')
    // This commits with the external intent, before a wallet can see its transaction request.
    const pending = await tx.query(`UPDATE ac_synthetic_worlds SET pending_acceptance=$2 WHERE job_id=$1 AND lock_hash=$3
      AND report->>'reportHash'=$4 AND (pending_acceptance IS NULL OR pending_acceptance=$2) RETURNING job_id`,
    [demo.job_id, operationId, inspection.report.lockHash, inspection.report.reportHash])
    if (!pending.rowCount) fail('INSPECTION_LOCK_UNAVAILABLE')
  }
  async function sync(agreementHash) {
    const { demo, agreement } = await context(agreementHash)
    const actions = {}
    for (const action of HUMAN_ACTIONS) actions[action] = await result(demo, agreement, action, true)
    const funded = actions.fund, event = funded?.evidence?.events?.funded
    if (final(funded) && event?.jobId === agreement.terms.jobId && event.agreementHash === agreement.hash &&
        address(event.requester) === address(agreement.terms.requester) && String(event.total) === HUMAN_LABOR) {
      // A review-link timeout cannot cancel canonical funding of the already signed terms.
      await store.query("UPDATE agreement_records SET state='funded',funded_at_ms=$2,funding_evidence=$3 WHERE agreement_hash=$1 AND state='approved'", [agreementHash, clock(),
        { source: 'external_human_wallet', operationId: funded.operationId, transactionHash: funded.txHash, blockHash: funded.receiptBlockHash }])
    }
    const world = new SyntheticWorld({ store, manifest: {}, settlement: externalAcceptanceVerifier({ client, deployment, external, demo, agreement }) })
    if (final(actions.accept)) await world.release(demo.job_id)
    return { agreementHash, jobId: demo.job_id, actions, inspection: demo.inspection,
      source: 'separate_synthetic_contract_demo', humanGameplayVerified: false, economicBridge: false }
  }
  async function fundingPlan(agreementHash) {
    const { demo, agreement } = await context(agreementHash), tokenAbi = await abi('CreditToken')
    const [requesterEth, builderEth, requesterCred, escrowAllowance, procurementAllowance] = await Promise.all([
      client.getBalance({ address: agreement.terms.requester }), client.getBalance({ address: agreement.terms.builder }),
      client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'balanceOf', args: [agreement.terms.requester] }),
      client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'allowance', args: [agreement.terms.requester, deployment.jobEscrow] }),
      client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'allowance', args: [agreement.terms.requester, deployment.procurement] })])
    return asJson({ agreementHash, jobId: demo.job_id, chainId: 1301, realMoneyBudget: 0, requester: agreement.terms.requester, builder: agreement.terms.builder,
      laborCred: HUMAN_LABOR, maximumMaterialCred: HUMAN_MATERIAL_CAP, totalMaximumCred: String(BigInt(HUMAN_LABOR) + BigInt(HUMAN_MATERIAL_CAP)),
      requesterCred, requesterEthWei: requesterEth, builderEthWei: builderEth, escrowAllowance, procurementAllowance,
      source: 'read_only_no_transfers_or_minting', missing: [requesterCred < BigInt(HUMAN_LABOR) + BigInt(HUMAN_MATERIAL_CAP) && 'requester test CRED', requesterEth === 0n && 'requester faucet ETH', builderEth === 0n && 'builder faucet ETH'].filter(Boolean) })
  }
  async function advanceSynthetic(agreementHash, { operator, provider = localOllama } = {}) {
    if (operator?.ready !== true || !operator.evm?.verify || !operator.attestor?.signTypedData || typeof operator.acknowledgeDelivery !== 'function') fail('EXPLICIT_READY_OPERATOR_REQUIRED')
    const { demo, agreement } = await context(agreementHash)
    await confirmed(demo, agreement, 'fund')
    const purchase = await confirmed(demo, agreement, 'buy')
    const accepted = await result(demo, agreement, 'accept', true)
    if (final(accepted)) {
      await sync(agreementHash)
      const claimed = await result(demo, agreement, 'claim', true)
      return { status: final(claimed) ? 'complete' : 'awaiting_manual_builder_claim', jobId: demo.job_id, inspection: demo.inspection,
        replay: true, additionalCredPaid: '0', newPurchases: 0, source: 'local_synthetic_world', economicBridge: false, humanTransactionsSubmittedByWorkflow: 0 }
    }
    if (operator.evm.instance !== demo.chain_instance || operator.evm.client !== client) fail('OPERATOR_CHAIN_CONTEXT_REQUIRED')
    const manifest = Object.fromEntries(Object.entries(JSON.parse(await readFile(new URL('fixtures/blueprints/calculator-v1.json', root), 'utf8')).material_bill).map(([item, count]) => [item, String(count)]))
    const kitAbi = await abi('KitCustody'), destination = destinationHash(agreement)
    const claims = new HumanClaimSource({ client, deployment, external, demo, agreement, store, kitAbi })
    const inventory = new SyntheticInventory({ store, manifest, manifestHash: deployment.bundleHash, claims })
    if (!(await store.query('SELECT 1 FROM ac_synthetic_stock WHERE manifest_hash=$1', [deployment.bundleHash])).rowCount) {
      const stock = Object.fromEntries(await Promise.all(Object.keys(manifest).map(async (item, index) => [item, String(await client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'controlledStock', args: [BigInt(index)] }))])))
      await inventory.seed(stock)
    }
    await inventory.registerDestination(destination, agreement.terms.requester)
    const claimKey = `${demo.chain_instance}:${deployment.kitCustody.toLowerCase()}:${purchase.evidence.claimId}`
    let delivery = (await store.query('SELECT * FROM ac_delivery_receipts WHERE claim_key=$1', [claimKey])).rows[0]
    if (!delivery) {
      await repository.enqueue(demo.job_id, demo.operation_ids.deliver, 'deliver', { claimKey })
      const operation = await repository.claim('human-synthetic-delivery', 30, 'deliver', demo.job_id)
      if (!operation) fail('SYNTHETIC_DELIVERY_LEASE_PENDING')
      delivery = await inventory.fulfill(operation)
    }
    const claim = await claims.confirmed(claimKey)
    if (!claim.alreadyDelivered) await operator.acknowledgeDelivery({ operationId: demo.operation_ids.acknowledge_delivery, claimId: purchase.evidence.claimId, receiptHash: delivery.receipt_hash })
    if (!(await claims.confirmed(claimKey)).alreadyDelivered) fail('CANONICAL_DELIVERY_ACKNOWLEDGEMENT_REQUIRED')
    const world = new SyntheticWorld({ store, manifest, settlement: externalAcceptanceVerifier({ client, deployment, external, demo, agreement }) })
    await world.create(demo.job_id, destination)
    let current = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0], inference = null
    if (!current.build_operation) {
      const { rows: [job] } = await store.query('SELECT * FROM ac_jobs WHERE id=$1', [demo.job_id])
      const leaseUntilMs = clock() + 60000
      const decisions = new DecisionService({ repository, provider, observe: async () => {
        const state = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0]
        return { jobId: demo.job_id, actorId: job.payload.builderActorId, sessionGeneration: 1, leaseEpoch: 1, leaseUntilMs,
          agreementDigest: agreement.hash, expectedRevision: Number(state.revision), actorAuthorized: true,
          authorizedConstruction: !state.build_operation && !state.lock_hash, lockMode: state.lock_hash ? 'REVIEW' : 'NONE' }
      } })
      const queued = (await store.query("SELECT * FROM ac_outbox WHERE job_id=$1 AND topic='construct' AND status IN ('pending','leased') ORDER BY created_at DESC LIMIT 1", [demo.job_id])).rows[0]
      if (queued && queued.payload.expiresAtMs <= clock()) await store.query("UPDATE ac_outbox SET status='expired' WHERE operation_id=$1 AND status IN ('pending','leased')", [queued.operation_id])
      if (!queued || queued.payload.expiresAtMs <= clock()) {
        const proposed = await decisions.propose(demo.job_id)
        inference = proposed.evidence
        if (proposed.proposal.action !== 'construct') fail('LOCAL_MODEL_CONSTRUCTION_NOT_PROPOSED')
        if ((await decisions.execute(proposed.id)).status !== 'queued') fail('SYNTHETIC_CONSTRUCTION_NOT_QUEUED')
      }
      const construction = await repository.claim('human-synthetic-builder', 30, 'construct', demo.job_id)
      if (!construction) fail('SYNTHETIC_CONSTRUCTION_LEASE_PENDING')
      await world.construct(demo.job_id, construction)
    }
    current = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0]
    let inspection = demo.inspection
    if (!inspection) {
      if (current.report) {
        if (current.report.lockHash !== current.lock_hash || current.report.agreementHash !== agreement.hash || current.report.jobId !== agreement.terms.jobId ||
            String(current.report.revision) !== String(current.revision) || BigInt(current.report.validUntil) <= (await client.getBlock()).timestamp) fail('INSPECTION_SIGNATURE_RECOVERY_REQUIRED')
        // Re-sign the exact protected report after a crash; never invent a newer pass or validity.
        inspection = { report: current.report, signature: await operator.attestor.signTypedData({ domain: agreement.domain, types: INSPECTION_TYPES, primaryType: 'Inspection', message: current.report }), source: 'local_synthetic_world' }
      } else {
        if (current.lock_hash) fail('INSPECTION_REPORT_RECOVERY_REQUIRED')
        const inspector = new InspectionCoordinator({ evm: operator.evm, world, attestor: operator.attestor, escrow: deployment.jobEscrow, abi: await abi('JobEscrow'), store })
        inspection = asJson(await inspector.issue(demo.job_id, agreement))
      }
      await store.query('UPDATE ac_human_demos SET inspection=COALESCE(inspection,$2) WHERE agreement_hash=$1', [agreementHash, inspection])
    }
    return { status: 'awaiting_manual_requester_acceptance', jobId: demo.job_id, deliveryReceipt: delivery.receipt_hash, inspection, inference,
      source: 'local_synthetic_world', economicBridge: false, humanTransactionsSubmittedByWorkflow: 0 }
  }
  return { register, resolveContext, onPrepared, prepareAction, sync, fundingPlan, advanceSynthetic, get: hash => context(hash) }
}

async function canonicalReceipt(client, result) {
  if (!final(result) || !result.receiptBlockNumber || !result.receiptBlockHash || !result.txHash) fail('CANONICAL_EXTERNAL_RECEIPT_REQUIRED')
  const blockNumber = BigInt(result.receiptBlockNumber)
  const [head, block] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber })])
  if (block.hash !== result.receiptBlockHash || head - blockNumber + 1n < 2n) fail('EXTERNAL_RECEIPT_REORGANIZED')
  return blockNumber
}

export class HumanClaimSource {
  constructor(options) { Object.assign(this, options) }
  async confirmed(claimKey) {
    const { client, deployment, external, demo, agreement } = this
    if (await client.getChainId() !== 1301 || demo.chain_instance !== `1301:${(await client.getBlock({ blockNumber: 0n })).hash}`) fail('HUMAN_CHAIN_INSTANCE_CHANGED')
    const purchase = await external.reconcile(demo.operation_ids.buy, agreement.terms.requester)
    const blockNumber = await canonicalReceipt(client, purchase), id = purchase.evidence?.claimId
    if (!/^0x[a-f0-9]{64}$/i.test(id || '') || purchase.agreementHash !== agreement.hash || purchase.action !== 'buy' ||
        address(purchase.sender) !== address(agreement.terms.requester) || address(purchase.request?.to || purchase.summary?.destination) !== address(deployment.procurement) ||
        !/^[1-9][0-9]*$/.test(String(purchase.evidence?.spentCred)) || BigInt(purchase.evidence.spentCred) > BigInt(HUMAN_MATERIAL_CAP) ||
        claimKey !== `${demo.chain_instance}:${deployment.kitCustody.toLowerCase()}:${id}`) fail('HUMAN_CLAIM_DOMAIN_MISMATCH')
    const kitAbi = this.kitAbi || await abi('KitCustody')
    const logs = await client.getContractEvents({ address: deployment.kitCustody, abi: kitAbi, eventName: 'ClaimCreated', args: { claimId: id }, fromBlock: blockNumber, toBlock: blockNumber })
    const event = logs.length === 1 && logs[0]
    const expectedDestination = destinationHash(agreement)
    const claim = await client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'claims', args: [id] })
    if (!event || event.transactionHash !== purchase.txHash || event.blockHash !== purchase.receiptBlockHash ||
        event.args.jobId !== agreement.terms.jobId || address(event.args.recipient) !== address(agreement.terms.requester) || event.args.kits !== 1n || event.args.destinationHash !== expectedDestination ||
        claim[0] !== agreement.terms.jobId || address(claim[1]) !== address(agreement.terms.requester) || claim[2] !== expectedDestination || claim[3] !== 1n ||
        await client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'bundleHash' }) !== deployment.bundleHash) fail('HUMAN_CLAIM_BINDING_MISMATCH')
    const { rows: [job] } = await this.store.query('SELECT * FROM ac_jobs WHERE id=$1', [demo.job_id])
    if (!job || job.agreement_digest !== agreement.hash || job.payload.chainInstance !== demo.chain_instance || job.payload.chainJobId !== agreement.terms.jobId) fail('HUMAN_CLAIM_JOB_MISMATCH')
    return { claimKey, confirmed: true, alreadyDelivered: claim[4], jobId: demo.job_id, manifestHash: deployment.bundleHash,
      recipient: agreement.terms.requester, destinationHash: expectedDestination, kits: '1', blockHash: event.blockHash }
  }
}

export function externalAcceptanceVerifier({ client, deployment, external, demo, agreement }) {
  async function outcome(jobId, operationId, report) {
    if (jobId !== demo.job_id || operationId !== demo.operation_ids.accept || report?.jobId !== agreement.terms.jobId || report.agreementHash !== agreement.hash) return null
    if (await client.getChainId() !== 1301 || demo.chain_instance !== `1301:${(await client.getBlock({ blockNumber: 0n })).hash}`) fail('HUMAN_CHAIN_INSTANCE_CHANGED')
    const result = await external.get(operationId, agreement.terms.requester)
    if (!result) return null
    const reconciled = await external.reconcile(operationId, agreement.terms.requester)
    if (reconciled.action !== 'accept' || reconciled.agreementHash !== agreement.hash || address(reconciled.sender) !== address(agreement.terms.requester) ||
        address(reconciled.request?.to || reconciled.summary?.destination) !== address(deployment.jobEscrow) || !reconciled.canonical || reconciled.confirmations < 2 || reconciled.chainId !== 1301) return null
    if (reconciled.status === 'reverted') {
      const canonical = { ...reconciled, status: 'confirmed' }
      await canonicalReceipt(client, canonical)
      return { reverted: true }
    }
    if (!final(reconciled)) return null
    const blockNumber = await canonicalReceipt(client, reconciled)
    const logs = await client.getContractEvents({ address: deployment.jobEscrow, abi: await abi('JobEscrow'), eventName: 'Accepted', args: { jobId: report.jobId }, fromBlock: blockNumber, toBlock: blockNumber })
    return { accepted: logs.some(log => log.transactionHash === reconciled.txHash && log.blockHash === reconciled.receiptBlockHash && log.args.reportHash === report.reportHash && String(log.args.revision) === String(report.revision)) }
  }
  return { time: async () => (await client.getBlock()).timestamp,
    accepted: async (jobId, operationId, report) => (await outcome(jobId, operationId, report))?.accepted === true,
    reverted: async (jobId, operationId, report) => (await outcome(jobId, operationId, report))?.reverted === true }
}
