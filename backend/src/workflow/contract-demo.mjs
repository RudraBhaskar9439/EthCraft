import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { PostgresStore } from '../storage/postgres.mjs'
import { WorkflowRepository } from '../workflow/repository.mjs'
import { LocalEvm } from '../chain/local-evm.mjs'
import { openTestnetRuntime } from '../chain/testnet-runtime.mjs'
import { publishDemoDiscovery } from '../discovery/demo-discovery.mjs'
import { completeSyntheticJob } from './complete-job.mjs'
import { createIdentityService } from '../identity/service.mjs'
import { createAgreementService, prepareAgreement, agreementTypedData } from '../agreements/service.mjs'

const require = createRequire(new URL('../../package.json', import.meta.url))

export async function runContractDemo({ publicTestnet = false } = {}) {
  const { acquireLocalLease } = require('./src/bot/checkpoint-store.cjs')
  const releaseDemo = await acquireLocalLease(publicTestnet ? 'agentcity-public-contract-demo-1301' : 'agentcity-local-demo-31337-8547')
  let publicRuntime, administrator, store
  try {
    const { encodeFunctionData, keccak256, stringToHex, decodeEventLog } = require('viem')
    const { mnemonicToAccount } = require('viem/accounts')
    const root = new URL('../../../', import.meta.url)
    async function sourceSnapshot() {
      const paths = ['scripts/local_demo.mjs', 'backend/package-lock.json', 'contracts/package-lock.json', publicTestnet ? '.local/public-testnet/deployment.json' : 'contracts/local-deployment.json',
        'fixtures/blueprints/calculator-v1.json', 'fixtures/test-manifests/calculator-v1.json', 'fixtures/construction/access-v1.json']
      async function collect(directory) {
        for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
          const path = directory + entry.name
          if (entry.isDirectory()) await collect(path + '/')
          else if (entry.isFile()) paths.push(path)
        }
      }
      await collect('backend/src/')
      await collect('contracts/abi/')
      return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')])))
    }
    const sourceBefore = await sourceSnapshot()
    const load = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))
    publicRuntime = publicTestnet ? await openTestnetRuntime() : null
    const deployment = await load(publicTestnet ? '.local/public-testnet/deployment.json' : 'contracts/local-deployment.json')
    if (deployment.environment !== (publicTestnet ? 'PUBLIC_TESTNET_SYNTHETIC_ONLY' : 'LOCAL_SYNTHETIC_ONLY') || deployment.chainId !== (publicTestnet ? 1301 : 31337)) throw new Error('synthetic_test_environment_required')
    const environment = await load('.local/backend/environment.json')
    administrator = new PostgresStore(environment.databaseUrl)
    const runId = randomUUID()
    const schema = publicRuntime?.schema || 'local_demo_' + runId.replaceAll('-', '')
    await administrator.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    const databaseUrl = new URL(environment.databaseUrl)
    databaseUrl.searchParams.set('options', '-c search_path=' + schema)
    store = new PostgresStore(databaseUrl.toString())
    const phases = []
    const transactions = []
    const record = (phase, detail) => { phases.push({ phase, detail, status: 'pass' }); console.log(`PASS ${phase}: ${detail}`) }
    const report = { runId, status: 'fail', mode: deployment.environment, phases, transactions, realMoneySpent: 0,
      sources: sourceBefore,
      economyBoundary: 'Contract demonstration only. No token balance, claim or payout affects Minecraft.',
      limits: ['Actual local Ollama inference; local test wallets and synthetic inventory/world observations.', 'No independent humans, live 0G or token-linked Minecraft operation.'] }
    const output = new URL(`evidence/runs/${publicTestnet ? 'public-testnet-e2e' : 'local-e2e'}/${runId}/`, root)
    await mkdir(output, { recursive: true })

    try {
      await store.migrate(['workflow', 'chain', 'delivery', 'inspection', 'identity', 'agreements', 'procurement'].map(name => new URL(`backend/src/${name}/schema.sql`, root)))
      const abi = Object.fromEntries(await Promise.all(['CreditToken', 'KitCustody', 'StateRegistry', 'Procurement', 'JobEscrow'].map(async name => [name, await load(`contracts/abi/${name}.json`)])))
      // Public Anvil test mnemonic. These accounts must never be used on a public network.
      const accounts = publicRuntime ? ['admin', 'warehouse', 'publisher', 'attestor', 'requester', 'builder', 'issuer'].map(role => publicRuntime.accounts[role]) : Array.from({ length: 7 }, (_, addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }))
      const [admin, warehouse, publisher, attestor, requester, builder, issuer] = accounts
      for (const [name, account] of Object.entries({ admin, warehouse, publisher, attestor, requester, builder, issuer })) assert.equal(account.address.toLowerCase(), deployment[name].toLowerCase())
      assert.equal(new Set(accounts.map(account => account.address.toLowerCase())).size, 7)
      const { createPublicClient, http } = require('viem')
      const rpc = publicRuntime?.evm.client || createPublicClient({ transport: http(deployment.rpcUrl, { retryCount: 0 }) })
      const genesisHash = (await rpc.getBlock({ blockNumber: 0n })).hash
      const evm = publicRuntime?.evm || new LocalEvm({ store, rpcUrl: deployment.rpcUrl, genesisHash })
      await evm.verify()
      if (!publicTestnet) await evm.client.request({ method: 'evm_mine' })
      const send = async (account, address, contractAbi, functionName, args, operationId = randomUUID()) => {
        const calldata = encodeFunctionData({ abi: contractAbi, functionName, args })
        await evm.prepare(operationId, account, address, calldata)
        const submitted = await evm.broadcast(operationId)
        assert.equal(submitted.status, 'submitted')
        const result = await evm.receipt(operationId)
        assert.equal(result.status, 'confirmed', functionName + ' must confirm')
        transactions.push({ operationId, functionName, hash: result.hash, blockNumber: result.receipt.blockNumber.toString() })
        return { operationId, ...result }
      }
      const chainJobId = keccak256(stringToHex(runId))
      const fileHash = async path => '0x' + createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')
      const now = (await evm.client.getBlock()).timestamp
      const context = { domain: { chainId: deployment.chainId, verifyingContract: deployment.jobEscrow }, serverId: deployment.serverId,
        bundleHash: deployment.bundleHash, blueprintHash: await fileHash('fixtures/blueprints/calculator-v1.json'),
        testsHash: await fileHash('fixtures/test-manifests/calculator-v1.json'), accessHash: await fileHash('fixtures/construction/access-v1.json'),
        cred: deployment.creditToken, kit: deployment.kitCustody }
      const input = {
        terms: { jobId: chainJobId, serverId: context.serverId, version: '1', requester: requester.address, builder: builder.address,
          cred: context.cred, kit: context.kit, bundleHash: context.bundleHash, blueprintHash: context.blueprintHash,
          testsHash: context.testsHash, accessHash: context.accessHash, materialCap: '3000000000000000000',
          workDeadline: (now + 3600n).toString(), reviewDeadline: (now + 4500n).toString(), passDeadline: (now + 4500n).toString(), absoluteExpiry: (now + 4500n).toString() },
        scope: { worldId: 'synthetic-local-' + runId, plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5],
          orientation: 'identity', startAt: now.toString(), approvalExpiresAtMs: String(Date.now() + 300000),
          ownershipPolicyHash: keccak256(stringToHex('requester owns purchased materials and placed structure')),
          refundPolicyHash: keccak256(stringToHex('unaccepted timeout refund; accepted allocations stay claimable')),
          inferenceBudgetMicrousd: '0', nativeGasBudgetWei: publicTestnet ? '8000000000000000' : '0' },
        allocations: [{ recipient: builder.address, amount: '6000000000000000000' }]
      }
      const prepared = prepareAgreement({ ...input, domain: context.domain })
      const requesterSignature = await requester.signTypedData(agreementTypedData(prepared))
      const builderSignature = await builder.signTypedData(agreementTypedData(prepared))
      const fixtureSessions = new Map()
      const identityServerId = publicTestnet ? 'agentcity-separate-contract-demo-1301' : 'agentcity-local-server'
      assert.equal(keccak256(stringToHex(identityServerId)), context.serverId)
      const identity = createIdentityService({ store, context: { serverId: identityServerId, origin: `http://127.0.0.1:${process.env.AGENTCITY_LOCAL_PORT || 8789}`, chainId: deployment.chainId },
        resolveSession: async binding => {
          const session = fixtureSessions.get(binding.sessionId)
          return session?.playerUuid === binding.playerUuid ? session : null
        } })
      for (const account of [requester, builder]) {
        const prior = (await store.query('SELECT player_uuid FROM identity_links WHERE server_id=$1 AND wallet=$2', [identityServerId, account.address.toLowerCase()])).rows[0]
        const playerUuid = prior?.player_uuid || randomUUID(), sessionId = randomUUID()
        fixtureSessions.set(sessionId, { playerUuid, sessionId, serverId: identityServerId, expiresAtMs: Date.now() + 300000 })
        const challenge = await identity.issueChallenge({ playerUuid, sessionId, wallet: account.address })
        const signature = await account.signTypedData(challenge.typedData)
        await identity.linkWallet({ challengeId: challenge.id, playerUuid, sessionId, wallet: account.address, signature })
      }
      const agreements = createAgreementService({ store, context, verifyFunding: async ({ record: agreement, evidence }) => {
        const confirmed = await evm.receipt(evidence.operationId)
        if (confirmed.status !== 'confirmed') return false
        const events = await evm.client.getContractEvents({ address: deployment.jobEscrow, abi: abi.JobEscrow, eventName: 'Funded', args: { jobId: agreement.terms.jobId }, fromBlock: confirmed.receipt.blockNumber, toBlock: confirmed.receipt.blockNumber })
        return events.some(event => event.transactionHash === confirmed.hash && event.args.agreementHash === agreement.hash && event.args.requester.toLowerCase() === requester.address.toLowerCase() && event.args.total === 6000000000000000000n)
      } })
      await agreements.create(input, requester.address)
      await agreements.approve(prepared.hash, requester.address, requesterSignature)
      await agreements.approve(prepared.hash, builder.address, builderSignature)
      const funding = await send(requester, deployment.jobEscrow, abi.JobEscrow, 'fund', [prepared.terms, [builder.address], [6000000000000000000n], requesterSignature, builderSignature])
      const agreement = await agreements.freezeFunded(prepared.hash, { operationId: funding.operationId })
      assert.equal(agreement.state, 'funded')
      if (publicTestnet) report.arkiv = await publishDemoDiscovery({ jobId: chainJobId, agreementHash: prepared.hash, blueprintHash: context.blueprintHash, serverId: context.serverId })
      record('P4', publicTestnet ? 'real public signatures, durable wallet links and live Arkiv profile/job/offer discovery' : 'real local signatures, durable wallet links and one canonical funded agreement')
      const repository = new WorkflowRepository(store)
      const jobId = randomUUID()
      const builderActorId = randomUUID()
      await repository.createJob({ id: jobId, agreementDigest: prepared.hash, payload: { chainJobId, chainInstance: evm.instance, requester: requester.address, kitAddress: deployment.kitCustody, builderActorId } })
      const sequence = await evm.client.readContract({ address: deployment.stateRegistry, abi: abi.StateRegistry, functionName: 'sequence' })
      await send(publisher, deployment.stateRegistry, abi.StateRegistry, 'publish', [sequence + 1n, true, (await evm.client.getBlock()).timestamp + 300n])
      assert.equal(await evm.client.readContract({ address: deployment.kitCustody, abi: abi.KitCustody, functionName: 'backed' }), true)
      assert.equal((await evm.client.readContract({ address: deployment.creditToken, abi: abi.CreditToken, functionName: 'issuer' })).toLowerCase(), issuer.address.toLowerCase())
      assert.equal((await evm.client.readContract({ address: deployment.kitCustody, abi: abi.KitCustody, functionName: 'issuer' })).toLowerCase(), issuer.address.toLowerCase())
      record('P5', 'actual CRED/KIT bytecode and item-level synthetic backing verified')
      const { createProcurementService } = await import('../procurement/service.mjs')
      const procurement = createProcurementService({ store, evm, deployment, account: requester, confirmations: publicTestnet ? 2 : 1 })
      const purchaseId = randomUUID()
      const quoteDeadline = (await evm.client.getBlock()).timestamp + 60n
      await procurement.prepare({ operationId: purchaseId, agreementHash: prepared.hash, kits: '1', maxCred: input.terms.materialCap, deadline: quoteDeadline.toString() })
      await procurement.broadcast(purchaseId)
      await procurement.reconcile(purchaseId)
      const purchased = await procurement.get(purchaseId)
      assert.ok(purchased.claim_id, 'the confirmed purchase must retain the actual event claim id')
      report.purchase = { operationId: purchaseId, transactionHash: purchased.transaction_hash, claimId: purchased.claim_id, spentCred: purchased.spent_cred }
      record('P6', 'fresh state and the correctly attached hook permit a real v4 exact-output swap')
      const completed = await completeSyntheticJob({ store, evm, accounts: { requester, builder, attestor, warehouse }, deployment, agreement, jobId, purchased, record })
      Object.assign(report, completed)
      report.jobId = jobId
      report.agreementHash = prepared.hash
      report.schema = schema
      report.chainGenesisHash = genesisHash
      report.purchase = purchased
      assert.deepEqual(await sourceSnapshot(), sourceBefore, 'Runtime source changed during the local flow')
      report.sourceIntegrityPassed = true
      report.status = 'pass'
    } catch (error) {
      report.status = 'fail'
      report.error = { name: error.name, message: error.message.slice(0, 1500) }
      process.exitCode = 1
    } finally {
      report.finishedAt = new Date().toISOString()
      await writeFile(new URL('report.json', output), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n')
      const reportPath = fileURLToPath(new URL('report.json', output))
      await writeFile(new URL(publicTestnet ? '.local/public-testnet/latest-demo.json' : '.local/backend/latest-demo.json', root), JSON.stringify({ schema, runId, report: reportPath }, null, 2) + '\n')
      console.log(JSON.stringify({ status: report.status, evidence: reportPath, error: report.error }))
    }
  } finally {
    if (store) await store.close()
    if (administrator) await administrator.close()
    if (publicRuntime) await publicRuntime.close()
    await releaseDemo()
  }
}
