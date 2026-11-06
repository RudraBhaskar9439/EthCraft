import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PostgresStore } from '../storage/postgres.mjs'
import { createAgreementService } from '../agreements/service.mjs'
import { createHandoffService } from './handoff.mjs'
import { createMinecraftIdentityService } from './minecraft-sessions.mjs'

const root = new URL('../../../', import.meta.url)
export async function openWalletHandoffs(origin) {
  const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
  const deployment = JSON.parse(await readFile(new URL('.local/public-testnet/deployment.json', root), 'utf8'))
  if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY') throw new Error('testnet_handoff_required')
  const url = new URL(settings.databaseUrl)
  url.searchParams.set('options', '-c search_path=public_testnet_1301')
  const store = new PostgresStore(url.toString())
  try {
    await store.query('CREATE SCHEMA IF NOT EXISTS public_testnet_1301')
    await store.migrate([new URL('backend/src/agreements/schema.sql', root)])
    await store.migrate([new URL('backend/src/identity/schema.sql', root)])
    const digest = async path => '0x' + createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')
    const context = { domain: { chainId: 1301, verifyingContract: deployment.jobEscrow }, serverId: deployment.serverId,
      cred: deployment.creditToken, kit: deployment.kitCustody, bundleHash: deployment.bundleHash,
      blueprintHash: await digest('fixtures/blueprints/calculator-v1.json'), testsHash: await digest('fixtures/test-manifests/calculator-v1.json'), accessHash: await digest('fixtures/construction/access-v1.json') }
    const agreements = createAgreementService({ store, context, verifyFunding: async () => { throw new Error('signing_handoff_does_not_fund_agreements') } })
    // The identity wrapper is lazy and fails closed without the owned live online-mode probe.
    const identity = createMinecraftIdentityService({ store, origin })
    const service = createHandoffService({ store, agreements, identity, deployment, origin })
    await service.initialize()
    return { service, agreements, identity, context, close: () => store.close() }
  } catch (error) { await store.close(); throw error }
}
