import { readFile } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { unichainSepolia } from 'viem/chains'
import { PostgresStore } from '../storage/postgres.mjs'
import { createExternalWalletService } from '../chain/external-wallet.mjs'
import { createHumanDemoWorkflow } from './human-demo.mjs'

const root = new URL('../../../', import.meta.url)
/** Public RPC and durable records only. This runtime never opens any private keystore. */
export async function openHumanDemoRuntime({ identityServerId, origin = 'http://127.0.0.1:8789' } = {}) {
  const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
  const deployment = JSON.parse(await readFile(new URL('.local/public-testnet/deployment.json', root), 'utf8'))
  if (deployment.chainId !== 1301 || deployment.environment !== 'PUBLIC_TESTNET_SYNTHETIC_ONLY') throw new Error('UNICHAIN_SEPOLIA_REQUIRED')
  const url = new URL(settings.databaseUrl)
  url.searchParams.set('options', '-c search_path=public_testnet_1301')
  const store = new PostgresStore(url.toString())
  try {
    await store.migrate(['workflow/schema.sql', 'chain/schema.sql', 'agreements/schema.sql', 'identity/schema.sql', 'delivery/schema.sql', 'inspection/schema.sql', 'workflow/human-demo.sql', 'chain/external-wallet.sql', 'workflow/human-demo-operator.sql'].map(file => new URL('backend/src/' + file, root)))
    const client = createPublicClient({ chain: unichainSepolia, transport: http('https://sepolia.unichain.org', { retryCount: 0, timeout: 15000 }) })
    let workflow
    const external = createExternalWalletService({ store, client, deployment, resolveContext: input => workflow.resolveContext(input), onPrepared: input => workflow.onPrepared(input) })
    workflow = createHumanDemoWorkflow({ store, client, deployment, external, identityServerId, origin })
    return { store, client, deployment, external, workflow, close: () => store.close() }
  } catch (error) { await store.close(); throw error }
}
