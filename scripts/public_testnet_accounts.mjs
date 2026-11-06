import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { openDevelopmentKeystore } from '../backend/src/chain/development-wallets.mjs'

const root = new URL('../', import.meta.url)
const directory = new URL('.local/public-testnet/roles/', root)
await mkdir(directory, { recursive: true, mode: 0o700 })
const settings = JSON.parse(await readFile(new URL('.local/public-testnet/account-settings.json', root), 'utf8'))
const admin = await openDevelopmentKeystore(settings)
const passwordFile = fileURLToPath(new URL('password', directory))
try { await writeFile(passwordFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST') throw error }
const password = (await readFile(passwordFile, 'utf8')).trim()
const accounts = { admin: { ...settings, address: admin.address } }
for (const role of ['warehouse', 'publisher', 'attestor', 'requester', 'builder', 'issuer']) {
  const keystore = fileURLToPath(new URL(role, directory))
  try { await stat(keystore) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const result = spawnSync('cast', ['wallet', 'new', fileURLToPath(directory), role], { env: { ...process.env, CAST_PASSWORD: password }, encoding: 'utf8', timeout: 15000 })
    if (result.status !== 0) throw new Error('testnet_role_keystore_creation_failed')
  }
  await chmod(keystore, 0o600)
  const account = await openDevelopmentKeystore({ keystore, passwordFile })
  accounts[role] = { keystore, passwordFile, address: account.address }
}
if (new Set(Object.values(accounts).map(role => role.address.toLowerCase())).size !== 7) throw new Error('distinct_testnet_roles_required')
await writeFile(new URL('.local/public-testnet/accounts.json', root), JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ scope: 'Disposable public-testnet roles; encrypted keys stay outside Git', roles: Object.fromEntries(Object.entries(accounts).map(([role, value]) => [role, value.address])) }))
