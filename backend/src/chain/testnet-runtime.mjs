import { readFile } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { PostgresStore } from '../storage/postgres.mjs'
import { openDevelopmentKeystore } from './development-wallets.mjs'
import { PublicTestnetEvm } from './public-testnet.mjs'

const root = new URL('../../../', import.meta.url)
export async function openTestnetRuntime(chainId = 1301) {
  const settings = JSON.parse(await readFile(new URL('.local/backend/environment.json', root), 'utf8'))
  const accountSettings = JSON.parse(await readFile(new URL('.local/public-testnet/accounts.json', root), 'utf8'))
  const accounts = Object.fromEntries(await Promise.all(Object.entries(accountSettings).map(async ([role, value]) => [role, await openDevelopmentKeystore(value)])))
  const rpcUrl = chainId === 1301 ? 'https://sepolia.unichain.org' : chainId === 7738577 ? 'https://rpc.tiramisu.db-chain.testnet.arkiv.network' : null
  if (!rpcUrl) throw new Error('unsupported_public_testnet')
  const administrator = new PostgresStore(settings.databaseUrl)
  let store
  try {
    const schema = 'public_testnet_' + chainId
    await administrator.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    const url = new URL(settings.databaseUrl)
    url.searchParams.set('options', '-c search_path=' + schema)
    store = new PostgresStore(url.toString())
    await store.migrate([new URL('backend/src/chain/schema.sql', root)])
    const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions: { headers: { 'User-Agent': 'AgentCity/0.1' } } }) })
    const genesisHash = (await client.getBlock({ blockNumber: 0n })).hash
    const evm = new PublicTestnetEvm({ store, chainId, rpcUrl, genesisHash, environment: 'PUBLIC_TESTNET_SYNTHETIC_ONLY', allowedSigners: Object.values(accounts).map(account => account.address) })
    await evm.verify()
    return { store, evm, accounts, schema, close: async () => { await store.close(); await administrator.close() } }
  } catch (error) { if (store) await store.close(); await administrator.close(); throw error }
}
