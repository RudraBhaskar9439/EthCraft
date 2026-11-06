import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createIdentityService } from '../../backend/src/identity/service.mjs'
import { createAgreementService, agreementTypedData } from '../../backend/src/agreements/service.mjs'
import { createHumanDemoWorkflow, HumanClaimSource, externalAcceptanceVerifier, requireHumanIdentities } from '../../backend/src/workflow/human-demo.mjs'
import { createHumanDemoOperator, testResourceDeficits } from '../../backend/src/workflow/human-demo-operator.mjs'
import { SyntheticWorld } from '../../backend/src/inspection/synthetic-world.mjs'
import { destinationHash } from '../../backend/src/procurement/service.mjs'

const root = new URL('../../', import.meta.url), runId = randomUUID(), checks = []
const require = createRequire(new URL('backend/package.json', root))
const { keccak256, stringToHex, encodeEventTopics, encodeAbiParameters, decodeFunctionData, zeroAddress } = require('viem')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
const administrator = new PostgresStore(settings.databaseUrl), schema = 'human_demo_fixture_' + runId.replaceAll('-', '')
await administrator.query('CREATE SCHEMA ' + schema)
const url = new URL(settings.databaseUrl)
url.searchParams.set('options', '-c search_path=' + schema)
const store = new PostgresStore(url.toString())
const report = { status: 'fail', runId, checks, scope: 'Actual isolated PostgreSQL, actual ephemeral fixture signatures and actual local Ollama; chain receipts/events and online sessions are explicitly scripted fixtures.',
  genuineHumanIdentitiesVerified: false, publicTransactionsSubmitted: 0, realMoneySpent: 0, economicBridge: false }
const check = name => { checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
const hash = value => keccak256(stringToHex(value))
try {
  await store.migrate(['workflow/schema.sql', 'chain/schema.sql', 'identity/schema.sql', 'agreements/schema.sql', 'delivery/schema.sql', 'inspection/schema.sql', 'workflow/human-demo.sql', 'workflow/human-demo-operator.sql'].map(path => new URL('backend/src/' + path, root)))
  const requester = privateKeyToAccount(generatePrivateKey()), builder = privateKeyToAccount(generatePrivateKey()), attestor = privateKeyToAccount(generatePrivateKey())
  const serverId = 'agentcity-online-auth-' + runId.replaceAll('-', ''), origin = 'http://127.0.0.1:8789'
  const deployment = { chainId: 1301, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', jobEscrow: '0x1111111111111111111111111111111111111111',
    creditToken: '0x2222222222222222222222222222222222222222', kitCustody: '0x3333333333333333333333333333333333333333', procurement: '0x4444444444444444444444444444444444444444',
    bundleHash: hash('fixture-bundle-' + runId), serverId: hash('fixture-contract-server'),
    issuer: '0x5555555555555555555555555555555555555555', admin: '0x6666666666666666666666666666666666666666' }
  await assert.rejects(requireHumanIdentities({ store, serverId, requester: requester.address, builder: builder.address }), /VERIFIED_WALLETLINK_BEFORE_AGREEMENT_REQUIRED/)
  const sessions = new Map(), identity = createIdentityService({ store, context: { serverId, origin, chainId: 1301 }, resolveSession: async binding => sessions.get(binding.sessionId) })
  for (const wallet of [requester, builder]) {
    const playerUuid = randomUUID(), sessionId = randomUUID()
    sessions.set(sessionId, { serverId, playerUuid, sessionId, expiresAtMs: Date.now() + 300000 })
    const challenge = await identity.issueChallenge({ playerUuid, sessionId, wallet: wallet.address })
    await identity.linkWallet({ challengeId: challenge.id, playerUuid, sessionId, wallet: wallet.address, signature: await wallet.signTypedData(challenge.typedData) })
  }
  await requireHumanIdentities({ store, serverId, requester: requester.address, builder: builder.address })
  await assert.rejects(requireHumanIdentities({ store, serverId, requester: requester.address, builder: builder.address, beforeMs: 1 }), /VERIFIED_WALLETLINK_BEFORE_AGREEMENT_REQUIRED/)
  check('distinct consumed WalletLink fixtures must precede the immutable agreement; missing and late links fail')

  const start = BigInt(Math.floor(Date.now() / 1000)), context = { domain: { chainId: 1301, verifyingContract: deployment.jobEscrow }, serverId: deployment.serverId,
    cred: deployment.creditToken, kit: deployment.kitCustody, bundleHash: deployment.bundleHash, blueprintHash: hash('blueprint'), testsHash: hash('tests'), accessHash: hash('access') }
  const agreements = createAgreementService({ store, context, verifyFunding: async () => false })
  const input = { terms: { jobId: hash(runId), serverId: context.serverId, version: '1', requester: requester.address, builder: builder.address, cred: context.cred, kit: context.kit,
    bundleHash: context.bundleHash, blueprintHash: context.blueprintHash, testsHash: context.testsHash, accessHash: context.accessHash, materialCap: '3000000000000000000',
    workDeadline: String(start + 3600n), reviewDeadline: String(start + 4500n), passDeadline: String(start + 4500n), absoluteExpiry: String(start + 4500n) },
    scope: { worldId: 'synthetic-human-demo-' + runId, plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5], orientation: 'identity',
      startAt: String(start), approvalExpiresAtMs: String(Date.now() + 900000), ownershipPolicyHash: hash('ownership'), refundPolicyHash: hash('refund'), inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '8000000000000000' },
    allocations: [{ recipient: builder.address, amount: '6000000000000000000' }] }
  let agreement = await agreements.create(input, requester.address)
  const blockHash = hash('fixture-block'), genesisHash = hash('fixture-genesis'), claimId = hash('fixture-claim')
  let chainTime = start + 5n, delivered = false, reorg = false, acknowledgeCalls = 0
  let requesterCredBalance = 1000000000000000000n, builderGasBalance = 100000000000000n
  const manifest = Object.fromEntries(Object.entries(JSON.parse(await readFile(new URL('fixtures/blueprints/calculator-v1.json', root), 'utf8')).material_bill).map(([item, quantity]) => [item, String(quantity)]))
  const actions = new Map(), logs = [], reconciledOperations = []
  const client = {
    getChainId: async () => 1301,
    getBlock: async ({ blockNumber } = {}) => ({ hash: blockNumber === 0n ? genesisHash : reorg ? hash('fixture-reorganized') : blockHash, timestamp: chainTime }),
    getBlockNumber: async () => 11n,
    getContractEvents: async ({ eventName }) => logs.filter(log => log.eventName === eventName),
    getBalance: async ({ address }) => address.toLowerCase() === builder.address.toLowerCase() ? builderGasBalance : 10000000000000000n,
    readContract: async ({ functionName, args }) => {
      if (functionName === 'claims') return [agreement.terms.jobId, agreement.terms.requester, destinationHash(agreement), 1n, delivered]
      if (functionName === 'bundleHash') return deployment.bundleHash
      if (functionName === 'controlledStock') return BigInt(Object.values(manifest)[Number(args[0])]) * 2n
      if (functionName === 'balanceOf') return requesterCredBalance
      if (functionName === 'issuer') return deployment.issuer
      if (functionName === 'allowance') return 0n
      if (functionName === 'status') return [agreement.hash, actions.has(demo?.operation_ids?.fund) ? 6000000000000000000n : 0n, false, false]
      throw new Error('unexpected_fixture_read_' + functionName)
    }
  }
  let workflow, rejectBeforeIntent = false
  const external = {
    get: async (id, actor) => { const result = actions.get(id) || null; if (result) assert.equal(result.sender.toLowerCase(), actor.toLowerCase()); return result },
    reconcile: async (id, actor) => { reconciledOperations.push(id); return external.get(id, actor) },
    prepare: async ({ operationId, agreementHash, action }, actor) => {
      const trusted = await store.transaction(tx => workflow.resolveContext({ agreementHash, action, actor, tx }))
      assert.equal(trusted.agreement.hash, agreementHash)
      const current = actions.get(operationId)
      if (current) return current
      if (rejectBeforeIntent) throw new Error('fixture_preflight_failed')
      const intent = { operationId, agreementHash, action, sender: actor, chainId: 1301, status: 'prepared', canonical: false, confirmations: 0,
        txHash: null, request: { from: actor, to: action === 'buy' ? deployment.procurement : deployment.jobEscrow } }
      await store.transaction(tx => workflow.onPrepared({ agreementHash, action, operationId, tx, intent }))
      actions.set(operationId, intent)
      return intent
    }
  }
  workflow = createHumanDemoWorkflow({ store, client, deployment, external, identityServerId: serverId })
  await assert.rejects(workflow.register(agreement.hash), /BOTH_HUMAN_AGREEMENT_APPROVALS_REQUIRED/)
  await agreements.approve(agreement.hash, requester.address, await requester.signTypedData(agreementTypedData(agreement)))
  agreement = await agreements.approve(agreement.hash, builder.address, await builder.signTypedData(agreementTypedData(agreement)))
  const demo = await workflow.register(agreement.hash)
  assert.deepEqual((await workflow.register(agreement.hash)).operation_ids, demo.operation_ids)
  await assert.rejects(workflow.prepareAction(agreement.hash, 'fund', builder.address), /HUMAN_ACTION_ROLE_REQUIRED/)
  await assert.rejects(workflow.prepareAction(agreement.hash, 'buy', requester.address), /CONFIRMED_FUND_REQUIRED/)
  await assert.rejects(store.query('UPDATE ac_human_demos SET identities=$2 WHERE agreement_hash=$1', [agreement.hash, {}]), /HUMAN_DEMO_BINDING_IMMUTABLE/)
  check('one durable human job pins exact 6/3 CRED terms, roles, historical identities and stable operation IDs')
  const confirm = (action, evidence = {}) => {
    const result = { operationId: demo.operation_ids[action], agreementHash: agreement.hash, action, chainId: 1301, sender: action === 'claim' ? builder.address : requester.address,
      status: 'confirmed', canonical: true, confirmations: 2, txHash: hash(action), receiptBlockNumber: '10', receiptBlockHash: blockHash, evidence,
      request: { to: action === 'buy' ? deployment.procurement : deployment.jobEscrow } }
    actions.set(result.operationId, result)
    return result
  }
  assert.deepEqual(testResourceDeficits(10000000000000000000n, 1000000000000000n), { credAmount: 0n, builderGasWei: 0n })
  assert.throws(() => testResourceDeficits(-1n, 0n), /INVALID_TEST_RESOURCE_BALANCE/)
  const tokenAbi = JSON.parse(await readFile(new URL('contracts/abi/CreditToken.json', root), 'utf8')), provisionCalls = new Map(), prepared = new Map()
  const fixtureEvm = {
    prepare: async (id, account, to, data, value) => {
      const existing = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [id])).rows[0]
      if (existing) { assert.equal(existing.destination, to.toLowerCase()); assert.equal(existing.calldata, data); return existing }
      prepared.set(id, { account, to, data, value })
      return (await store.query("INSERT INTO ac_chain_intents(operation_id,chain_instance,account,destination,calldata,nonce,raw_transaction,transaction_hash) VALUES($1,$2,$3,$4,$5,0,'explicit-unsigned-fixture',$6) RETURNING *", [id, demo.chain_instance, account.address.toLowerCase(), to.toLowerCase(), data, hash(id)])).rows[0]
    },
    broadcast: async id => {
      provisionCalls.set(id, (provisionCalls.get(id) || 0) + 1)
      const input = prepared.get(id)
      if (input.data !== '0x') requesterCredBalance += decodeFunctionData({ abi: tokenAbi, data: input.data }).args[1]
      else builderGasBalance += input.value
      await store.query("UPDATE ac_chain_intents SET status='confirmed' WHERE operation_id=$1", [id])
    },
    receipt: async id => {
      const row = (await store.query('SELECT * FROM ac_chain_intents WHERE operation_id=$1', [id])).rows[0], input = prepared.get(id), logs = []
      if (input.data !== '0x') {
        const amount = decodeFunctionData({ abi: tokenAbi, data: input.data }).args[1]
        logs.push({ address: deployment.creditToken, topics: encodeEventTopics({ abi: tokenAbi, eventName: 'Transfer', args: { from: zeroAddress, to: requester.address } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) })
      }
      return { status: row.status, hash: hash(id), receipt: { logs } }
    }
  }
  const operatorRuntime = { store, client, deployment, external, workflow }
  await assert.rejects(createHumanDemoOperator(operatorRuntime).provisionTestResources(agreement.hash), /EXPLICIT_OPERATOR_READINESS_REQUIRED/)
  const provisioning = createHumanDemoOperator(operatorRuntime, { ready: true, roleLoader: async roles => ({ accounts: Object.fromEntries(roles.map(role => [role, { address: deployment[role] }])), evm: fixtureEvm }) })
  const provisioned = await provisioning.provisionTestResources(agreement.hash)
  assert.equal(provisioned.status, 'confirmed')
  assert.equal(provisioned.plan.cred_amount, '8000000000000000000')
  assert.equal(provisioned.plan.builder_gas_wei, '100000000000000')
  assert.equal(requesterCredBalance, 9000000000000000000n)
  assert.equal(builderGasBalance, 200000000000000n)
  requesterCredBalance = 0n
  const provisionedAgain = await provisioning.provisionTestResources(agreement.hash)
  assert.equal(provisionedAgain.plan.cred_operation, provisioned.plan.cred_operation)
  assert.equal(provisionedAgain.plan.cred_amount, provisioned.plan.cred_amount)
  assert.equal(requesterCredBalance, 0n)
  assert.ok([...provisionCalls.values()].every(calls => calls === 1))
  check('explicit operator provisioning persists one bounded test deficit before fixture sends; replay never tops up spent balances')
  confirm('approve_escrow')
  await workflow.prepareAction(agreement.hash, 'fund', requester.address)
  const beforePoll = reconciledOperations.filter(id => id === demo.operation_ids.fund).length
  const polled = await workflow.sync(agreement.hash)
  assert.equal(polled.actions.fund.status, 'prepared')
  assert.ok(polled.actions.fund.request)
  assert.equal(reconciledOperations.filter(id => id === demo.operation_ids.fund).length, beforePoll)
  confirm('fund', { events: { funded: { jobId: agreement.terms.jobId, agreementHash: agreement.hash, requester: requester.address, total: '6000000000000000000' } } })
  await workflow.sync(agreement.hash)
  assert.equal((await agreements.get(agreement.hash)).state, 'funded')
  const plan = await workflow.fundingPlan(agreement.hash)
  assert.equal(plan.totalMaximumCred, '9000000000000000000')
  assert.equal(plan.transactionsSubmitted, undefined)
  confirm('approve_procurement')
  const buy = await workflow.prepareAction(agreement.hash, 'buy', requester.address)
  assert.equal(buy.operationId, demo.operation_ids.buy)
  actions.set(buy.operationId, { ...buy, status: 'unknown' })
  const originalQuote = (await workflow.get(agreement.hash)).demo.quote
  chainTime += 70n
  assert.equal((await workflow.prepareAction(agreement.hash, 'buy', requester.address)).operationId, buy.operationId)
  assert.deepEqual((await workflow.get(agreement.hash)).demo.quote, originalQuote)
  check('canonical funding freezes terms; read-only balances and unknown purchase retries preserve the same ID and cap')

  const purchase = confirm('buy', { claimId, spentCred: '2500000000000000000' })
  logs.push({ eventName: 'ClaimCreated', transactionHash: purchase.txHash, blockNumber: 10n, blockHash,
    args: { claimId, jobId: agreement.terms.jobId, recipient: requester.address, kits: 1n, destinationHash: destinationHash(agreement) } })
  const claims = new HumanClaimSource({ client, deployment, external, demo, agreement, store })
  const claimKey = `${demo.chain_instance}:${deployment.kitCustody.toLowerCase()}:${claimId}`
  assert.equal((await claims.confirmed(claimKey)).confirmed, true)
  reorg = true
  await assert.rejects(claims.confirmed(claimKey), /EXTERNAL_RECEIPT_REORGANIZED/)
  reorg = false
  await assert.rejects(claims.confirmed(claimKey + '00'), /HUMAN_CLAIM_DOMAIN_MISMATCH/)
  check('only canonical two-confirmation purchase and exact claim/job/bundle/destination authorize synthetic delivery')
  const evm = { instance: demo.chain_instance, client, verify: async () => assert.equal(await client.getChainId(), 1301) }
  const operator = { ready: true, evm, attestor, acknowledgeDelivery: async data => {
    assert.equal(data.operationId, demo.operation_ids.acknowledge_delivery)
    assert.equal(data.claimId, claimId)
    assert.match(data.receiptHash, /^0x[a-f0-9]{64}$/)
    acknowledgeCalls++
    delivered = true
  } }
  await assert.rejects(workflow.advanceSynthetic(agreement.hash), /EXPLICIT_READY_OPERATOR_REQUIRED/)
  const completed = await workflow.advanceSynthetic(agreement.hash, { operator })
  assert.equal(completed.status, 'awaiting_manual_requester_acceptance')
  assert.equal(completed.inspection.report.casesPassed, 16)
  assert.equal(completed.inspection.report.casesTotal, 16)
  assert.equal(completed.source, 'local_synthetic_world')
  assert.equal(completed.humanTransactionsSubmittedByWorkflow, 0)
  report.inference = completed.inference
  assert.equal(acknowledgeCalls, 1)
  const second = await workflow.advanceSynthetic(agreement.hash, { operator })
  assert.equal(second.deliveryReceipt, completed.deliveryReceipt)
  assert.equal(second.inference, null)
  assert.equal(acknowledgeCalls, 1)
  assert.equal((await store.query('SELECT count(*) FROM ac_delivery_receipts')).rows[0].count, '1')
  const worldRow = (await store.query('SELECT * FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0]
  assert.equal(worldRow.revision, '144')
  assert.ok(Object.values((await store.query('SELECT items FROM ac_synthetic_destinations')).rows[0].items).every(quantity => quantity === '0'))
  check('actual local Ollama proposes one fenced synthetic construction; exact material use, one delivery and protected 16-case inspection replay')
  const world = new SyntheticWorld({ store, manifest, settlement: externalAcceptanceVerifier({ client, deployment, external, demo, agreement }) })
  await assert.rejects(workflow.prepareAction(agreement.hash, 'accept', builder.address), /HUMAN_ACTION_ROLE_REQUIRED/)
  rejectBeforeIntent = true
  await assert.rejects(workflow.prepareAction(agreement.hash, 'accept', requester.address), /fixture_preflight_failed/)
  assert.equal((await store.query('SELECT pending_acceptance FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0].pending_acceptance, null)
  rejectBeforeIntent = false
  const acceptance = await workflow.prepareAction(agreement.hash, 'accept', requester.address)
  actions.set(acceptance.operationId, { ...acceptance, status: 'unknown' })
  chainTime = BigInt(completed.inspection.report.validUntil) + 1n
  await assert.rejects(world.release(demo.job_id), /usable_pass_lock_required/)
  await assert.rejects(workflow.prepareAction(agreement.hash, 'claim', builder.address), /CONFIRMED_ACCEPT_REQUIRED/)
  const accepted = confirm('accept', { events: { accepted: { jobId: agreement.terms.jobId, reportHash: completed.inspection.report.reportHash, revision: completed.inspection.report.revision } } })
  logs.push({ eventName: 'Accepted', transactionHash: accepted.txHash, blockHash,
    args: { jobId: agreement.terms.jobId, reportHash: completed.inspection.report.reportHash, revision: BigInt(completed.inspection.report.revision) } })
  await workflow.sync(agreement.hash)
  assert.equal((await store.query('SELECT lock_hash FROM ac_synthetic_worlds WHERE job_id=$1', [demo.job_id])).rows[0].lock_hash, null)
  assert.equal((await workflow.advanceSynthetic(agreement.hash, { operator })).status, 'awaiting_manual_builder_claim')
  const claim = await workflow.prepareAction(agreement.hash, 'claim', builder.address)
  assert.equal(claim.action, 'claim')
  assert.equal(actions.get(demo.operation_ids.claim).status, 'prepared')
  assert.equal(actions.size, 6)
  confirm('claim', { amount: '6000000000000000000' })
  const replayedCompletion = await workflow.advanceSynthetic(agreement.hash, { operator })
  assert.equal(replayedCompletion.status, 'complete')
  assert.equal(replayedCompletion.additionalCredPaid, '0')
  assert.equal(replayedCompletion.newPurchases, 0)
  assert.equal(acknowledgeCalls, 1)
  check('manual acceptance remains pending and locked through an unknown outcome; only canonical acceptance unlocks the manual builder claim')
  report.status = 'pass'
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; console.error(error) }
finally {
  report.finishedAt = new Date().toISOString()
  const output = new URL('evidence/runs/human-workflow/' + runId + '/', root)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify(report, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, evidence: output.pathname + 'report.json', publicTransactionsSubmitted: 0 }))
  await store.close(); await administrator.close()
}
