import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { encodeFunctionData, getAddress, parseEventLogs, verifyTypedData, zeroAddress } from 'viem'
import { agreementTypedData } from '../agreements/service.mjs'
import { openDevelopmentKeystore } from '../chain/development-wallets.mjs'
import { PublicTestnetEvm } from '../chain/public-testnet.mjs'
import { HUMAN_LABOR, HUMAN_MATERIAL_CAP } from './human-demo.mjs'

const root = new URL('../../../', import.meta.url)
const address = value => getAddress(value).toLowerCase()
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const fail = code => { throw new Error(code) }
const abi = async name => JSON.parse(await readFile(new URL(`contracts/abi/${name}.json`, root), 'utf8'))
export const BUILDER_TEST_GAS_TARGET = 200000000000000n
const MAX_CRED = BigInt(HUMAN_LABOR) + BigInt(HUMAN_MATERIAL_CAP)

export function testResourceDeficits(requesterCred, builderGas) {
  if (typeof requesterCred !== 'bigint' || typeof builderGas !== 'bigint' || requesterCred < 0n || builderGas < 0n) fail('INVALID_TEST_RESOURCE_BALANCE')
  return { credAmount: requesterCred < MAX_CRED ? MAX_CRED - requesterCred : 0n,
    builderGasWei: builderGas < BUILDER_TEST_GAS_TARGET ? BUILDER_TEST_GAS_TARGET - builderGas : 0n }
}

/** Explicit local operator only. No role is decrypted until an authorized method needs it. */
export async function readSyntheticMarketHealth({ client, deployment }) {
  if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY') fail('UNICHAIN_SEPOLIA_REQUIRED')
  const [registryAbi, kitAbi] = await Promise.all([abi('StateRegistry'), abi('KitCustody')])
  const read = name => client.readContract({ address: deployment.stateRegistry, abi: registryAbi, functionName: name })
  const [chainId, genesis, block, available, healthy, validUntil, sequence, publisher, marketId, backed] = await Promise.all([
    client.getChainId(), client.getBlock({ blockNumber: 0n }), client.getBlock(), read('available'), read('healthy'), read('validUntil'), read('sequence'), read('publisher'), read('marketId'),
    client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'backed' })])
  if (chainId !== 1301 || genesis.hash !== deployment.genesisHash || address(publisher) !== address(deployment.publisher)) fail('SYNTHETIC_HEALTH_CONTEXT_CHANGED')
  return json({ available, healthy, validUntil, sequence, publisher: address(publisher), marketId, backed, chainTimestamp: block.timestamp,
    refreshRequired: !available || BigInt(validUntil) <= block.timestamp + 90n, source: 'synthetic_contract_market', economicBridge: false, operatorRole: 'publisher' })
}

export function createHumanDemoOperator(runtime, { ready = false, roleLoader } = {}) {
  const { store, client, deployment, external, workflow } = runtime
  async function requireHumans(hash) {
    if (ready !== true) fail('EXPLICIT_OPERATOR_READINESS_REQUIRED')
    const { demo, agreement } = await workflow.get(hash)
    if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY' || await client.getChainId() !== 1301 ||
        demo.chain_instance !== `1301:${(await client.getBlock({ blockNumber: 0n })).hash}`) fail('UNICHAIN_SEPOLIA_REQUIRED')
    const identities = demo.identities
    if (!identities?.requester || !identities?.builder || identities.requester.playerUuid === identities.builder.playerUuid ||
        !/^agentcity-online-auth-[a-f0-9]{32}$/.test(demo.identity_server_id)) fail('TWO_VERIFIED_HUMAN_IDENTITIES_REQUIRED')
    for (const role of ['requester', 'builder']) {
      const identity = identities[role], wallet = agreement.terms[role]
      if (address(identity.wallet) !== address(wallet) || identity.source !== 'historical_online_minecraft_walletlink' || identity.linkedAtMs > agreement.createdAtMs) fail('HUMAN_IDENTITY_BINDING_REQUIRED')
      const approval = agreement.approvals.find(item => address(item.signer) === address(wallet))
      if (!approval || !await verifyTypedData({ ...agreementTypedData(agreement), address: wallet, signature: approval.signature })) fail('CRYPTOGRAPHIC_HUMAN_APPROVALS_REQUIRED')
    }
    return { demo, agreement }
  }
  async function openRoles(roles) {
    const settings = JSON.parse(await readFile(new URL('.local/public-testnet/accounts.json', root), 'utf8'))
    const accounts = {}
    for (const role of roles) {
      if (!['warehouse', 'attestor', 'issuer', 'admin', 'publisher'].includes(role) || !settings[role] || address(settings[role].address) !== address(deployment[role])) fail('DISCLOSED_OPERATOR_ROLE_REQUIRED')
      accounts[role] = await openDevelopmentKeystore(settings[role])
    }
    const evm = new PublicTestnetEvm({ store, chainId: 1301, rpcUrl: 'https://sepolia.unichain.org', genesisHash: deployment.genesisHash,
      environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: roles.filter(role => role !== 'attestor').map(role => accounts[role].address) })
    // One read authority is shared by workflow verification and operator receipt reconciliation.
    evm.client = client
    await evm.verify()
    return { accounts, evm }
  }
  async function humanFundingStarted(demo, agreement) {
    const status = await client.readContract({ address: deployment.jobEscrow, abi: await abi('JobEscrow'), functionName: 'status', args: [agreement.terms.jobId] })
    return BigInt(status[1]) > 0n || Boolean(await external.get(demo.operation_ids.fund, agreement.terms.requester) || await external.get(demo.operation_ids.buy, agreement.terms.requester))
  }
  async function summary(hash) {
    const plan = await workflow.fundingPlan(hash)
    return { ...plan, operatorReady: ready, builderTestGasTargetWei: String(BUILDER_TEST_GAS_TARGET),
      automaticTopups: false, disclosedOperatorRoles: { mint: 'issuer', gasSponsor: 'admin', deliveryAcknowledgement: 'warehouse', inspection: 'attestor', syntheticHealth: 'publisher' } }
  }
  async function advance(hash) {
    const { agreement } = await requireHumans(hash)
    const { accounts, evm } = await (roleLoader || openRoles)(['warehouse', 'attestor'])
    const [kitAbi, tokenAbi, escrowAbi] = await Promise.all([abi('KitCustody'), abi('CreditToken'), abi('JobEscrow')])
    if (address(await client.readContract({ address: deployment.kitCustody, abi: kitAbi, functionName: 'warehouse' })) !== address(accounts.warehouse.address)) fail('WAREHOUSE_ROLE_CHANGED')
    if (address(await client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'issuer' })) !== address(deployment.issuer)) fail('ISSUER_ROLE_CHANGED')
    if (address(await client.readContract({ address: deployment.jobEscrow, abi: escrowAbi, functionName: 'attestor' })) !== address(accounts.attestor.address)) fail('ATTESTOR_ROLE_CHANGED')
    const acknowledgeDelivery = async ({ operationId, claimId, receiptHash }) => {
      await evm.prepare(operationId, accounts.warehouse, deployment.kitCustody, encodeFunctionData({ abi: kitAbi, functionName: 'markDelivered', args: [claimId, receiptHash] }))
      await evm.broadcast(operationId)
      const result = await evm.receipt(operationId)
      if (result.status !== 'confirmed') fail('WAREHOUSE_ACKNOWLEDGEMENT_' + result.status.toUpperCase())
      return { operationId, transactionHash: result.hash }
    }
    const result = await workflow.advanceSynthetic(hash, { operator: { ready: true, evm, attestor: accounts.attestor, acknowledgeDelivery } })
    return { ...result, requester: agreement.terms.requester, builder: agreement.terms.builder, operatorRoles: ['warehouse', 'attestor'],
      awaiting: 'requester wallet acceptance, then builder wallet claim', realMoneySpent: 0 }
  }
  async function provisionTestResources(hash) {
    const { demo, agreement } = await requireHumans(hash), tokenAbi = await abi('CreditToken')
    let plan = (await store.query('SELECT * FROM ac_human_provisioning WHERE agreement_hash=$1', [hash])).rows[0]
    if (!plan) {
      if (await humanFundingStarted(demo, agreement)) fail('NO_NEW_PROVISIONING_AFTER_HUMAN_FUNDING_INTENT')
      const [credBalance, gasBalance] = await Promise.all([
        client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'balanceOf', args: [agreement.terms.requester] }),
        client.getBalance({ address: agreement.terms.builder })])
      const amounts = testResourceDeficits(credBalance, gasBalance)
      plan = await store.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['human-provisioning:' + hash])
        const prior = (await tx.query('SELECT * FROM ac_human_provisioning WHERE agreement_hash=$1', [hash])).rows[0]
        if (prior) return prior
        return (await tx.query(`INSERT INTO ac_human_provisioning(agreement_hash,chain_instance,requester,builder,cred_amount,builder_gas_wei,cred_operation,gas_operation,created_at_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [hash, demo.chain_instance, address(agreement.terms.requester), address(agreement.terms.builder),
          String(amounts.credAmount), String(amounts.builderGasWei), randomUUID(), randomUUID(), Date.now()])).rows[0]
      })
    }
    if (plan.chain_instance !== demo.chain_instance || plan.requester !== address(agreement.terms.requester) || plan.builder !== address(agreement.terms.builder)) fail('PROVISIONING_PLAN_BINDING_CHANGED')
    const outcomes = {}, needed = ['issuer', 'admin'].filter(role => BigInt(role === 'issuer' ? plan.cred_amount : plan.builder_gas_wei) > 0n)
    if (!needed.length) return { status: 'already_sufficient', agreementHash: hash, plan, outcomes, realMoneySpent: 0 }
    const { accounts, evm } = await (roleLoader || openRoles)(needed)
    if (needed.includes('issuer') && address(await client.readContract({ address: deployment.creditToken, abi: tokenAbi, functionName: 'issuer' })) !== address(accounts.issuer.address)) fail('ISSUER_ROLE_CHANGED')
    for (const role of needed) {
      const mint = role === 'issuer', operationId = mint ? plan.cred_operation : plan.gas_operation
      const current = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])).rows[0]
      if (!current && await humanFundingStarted(demo, agreement)) {
        outcomes[role] = { status: 'blocked', reason: 'NO_NEW_TOPUP_AFTER_HUMAN_FUNDING_INTENT', operationId }
        continue
      }
      try {
        const to = mint ? deployment.creditToken : plan.builder, amount = BigInt(mint ? plan.cred_amount : plan.builder_gas_wei)
        const data = mint ? encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [plan.requester, amount] }) : '0x'
        await evm.prepare(operationId, accounts[role], to, data, mint ? 0n : amount)
        let receipt = current ? await evm.receipt(operationId) : null
        if (!receipt || !['confirmed', 'reverted', 'reorganized'].includes(receipt.status)) {
          await evm.broadcast(operationId)
          receipt = await evm.receipt(operationId)
        }
        if (receipt.status === 'confirmed' && mint) {
          const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', logs: receipt.receipt.logs.filter(log => address(log.address) === address(deployment.creditToken)) })
          if (!transfers.some(log => address(log.args.from) === zeroAddress && address(log.args.to) === plan.requester && log.args.value === amount)) fail('CANONICAL_TEST_MINT_EVENT_REQUIRED')
        }
        outcomes[role] = { operationId, status: receipt.status, transactionHash: receipt.hash, amount: String(amount), replay: Boolean(current) }
      } catch (error) { outcomes[role] = { operationId, status: 'blocked', reason: error.code || error.message } }
    }
    return json({ status: Object.values(outcomes).every(item => item.status === 'confirmed') ? 'confirmed' : 'pending_or_blocked', agreementHash: hash, plan, outcomes,
      realMoneySpent: 0, fundingSource: 'disclosed faucet test ETH and issuer-created test CRED; no real-money purchase', repeatedProvisioningCreatesNewAmounts: false })
  }
  async function publishHealth(hash) {
    const { demo } = await requireHumans(hash)
    const { accounts, evm } = await (roleLoader || openRoles)(['publisher'])
    const registryAbi = await abi('StateRegistry')
    const instance = `1301:${deployment.genesisHash}`, topic = 'human.market.publish', registry = address(deployment.stateRegistry), publisher = address(deployment.publisher)
    if (address(accounts.publisher.address) !== publisher) fail('PUBLISHER_ROLE_CHANGED')
    function assertPayload(row) {
      const p = row.payload
      if (row.topic !== topic || p.chainInstance !== instance || p.registry !== registry || p.publisher !== publisher || !/^0x[0-9a-f]{64}$/i.test(p.agreementHash) || BigInt(p.sequence) <= 0n || BigInt(p.validUntil) <= 0n) fail('HEALTH_PUBLICATION_BINDING_CHANGED')
    }
    function assertEvent(row, result) {
      const events = parseEventLogs({ abi: registryAbi, eventName: 'StatePublished', logs: result.receipt.logs.filter(log => address(log.address) === registry), strict: true })
      const event = events[0]?.args, p = row.payload
      if (events.length !== 1 || event.marketId !== p.marketId || String(event.sequence) !== p.sequence || event.healthy !== true || String(event.validUntil) !== p.validUntil) fail('CANONICAL_SYNTHETIC_HEALTH_EVENT_REQUIRED')
    }
    const selected = await store.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['human-market-publish:' + instance + ':' + registry])
      const prior = (await tx.query("SELECT * FROM ac_outbox WHERE topic=$1 AND payload->>'chainInstance'=$2 AND payload->>'registry'=$3 ORDER BY created_at DESC,operation_id DESC LIMIT 1 FOR UPDATE", [topic, instance, registry])).rows[0]
      if (prior) {
        assertPayload(prior)
        if (prior.status !== 'complete') return { journal: prior }
        const canonical = await evm.receipt(prior.operation_id)
        if (canonical.status !== 'confirmed') {
          const journal = (await tx.query("UPDATE ac_outbox SET status='reorganized',receipt=$2 WHERE operation_id=$1 RETURNING *", [prior.operation_id, json(canonical)])).rows[0]
          return { journal }
        }
        assertEvent(prior, canonical)
      }
      const health = await readSyntheticMarketHealth(runtime)
      if (!health.backed) fail('SYNTHETIC_MARKET_NOT_BACKED')
      if (!health.refreshRequired) return { journal: null, health }
      const operationId = prior ? randomUUID() : demo.operation_ids.publish
      const payload = { agreementHash: hash, chainInstance: instance, registry, publisher, marketId: health.marketId,
        sequence: String(BigInt(health.sequence) + 1n), validUntil: String(BigInt(health.chainTimestamp) + 300n) }
      const journal = (await tx.query('INSERT INTO ac_outbox(operation_id,job_id,topic,payload) VALUES($1,$2,$3,$4) RETURNING *', [operationId, demo.job_id, topic, payload])).rows[0]
      return { journal }
    })
    const journal = selected.journal
    if (!journal) return { status: 'already_fresh', agreementHash: hash, health: selected.health, realMoneySpent: 0 }
    assertPayload(journal)
    const operationId = journal.operation_id, p = journal.payload
    try {
      const calldata = encodeFunctionData({ abi: registryAbi, functionName: 'publish', args: [BigInt(p.sequence), true, BigInt(p.validUntil)] })
      const current = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [operationId])).rows[0]
      if (current && (current.chain_instance !== instance || current.account !== publisher || current.destination !== registry || current.calldata !== calldata)) fail('HEALTH_PUBLICATION_BINDING_CHANGED')
      if (!current) {
        const health = await readSyntheticMarketHealth(runtime)
        if (!health.backed || BigInt(p.validUntil) <= BigInt(health.chainTimestamp) || BigInt(p.sequence) !== BigInt(health.sequence) + 1n) fail('HEALTH_PUBLICATION_RECONCILIATION_REQUIRED')
        await evm.prepare(operationId, accounts.publisher, registry, calldata)
      }
      let result = await evm.receipt(operationId)
      if (!['confirmed', 'reverted', 'reorganized'].includes(result.status)) {
        await evm.broadcast(operationId)
        result = await evm.receipt(operationId)
      }
      if (result.status === 'confirmed') assertEvent(journal, result)
      await store.query('UPDATE ac_outbox SET status=$2,receipt=$3 WHERE operation_id=$1', [operationId, result.status === 'confirmed' ? 'complete' : result.status, json(result)])
      return json({ status: result.status, agreementHash: hash, sourceAgreementHash: p.agreementHash, operationId, transactionHash: result.hash,
        health: await readSyntheticMarketHealth(runtime), realMoneySpent: 0, disclosedOperatorRole: 'publisher', retainedIntent: Boolean(current) })
    } catch (error) {
      const reason = /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'SYNTHETIC_HEALTH_PUBLICATION_PENDING_OR_BLOCKED'
      await store.query("UPDATE ac_outbox SET status=CASE WHEN status='complete' THEN status ELSE 'unknown' END,receipt=$2 WHERE operation_id=$1", [operationId, { failure: reason }])
      return { status: 'pending_or_blocked', agreementHash: hash, operationId, reason, realMoneySpent: 0, retainedIntent: true }
    }
  }
  return { summary, advance, provisionTestResources, publishHealth }
}
