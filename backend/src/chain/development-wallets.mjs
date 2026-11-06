import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

export async function openDevelopmentKeystore({ keystore, passwordFile, address }) {
  for (const path of [keystore, passwordFile]) {
    const file = await stat(path)
    if (!file.isFile() || (file.mode & 0o077) || file.uid !== process.getuid()) throw new Error('private_keystore_permissions_required')
  }
  const password = (await readFile(passwordFile, 'utf8')).trim()
  const result = spawnSync('cast', ['wallet', 'decrypt-keystore', basename(keystore), '--keystore-dir', dirname(keystore)], {
    env: { ...process.env, CAST_UNSAFE_PASSWORD: password }, encoding: 'utf8', timeout: 15000, maxBuffer: 8192
  })
  const key = result.status === 0 && result.stdout.match(/0x[0-9a-f]{64}/i)?.[0]
  if (!key) throw new Error('development_keystore_unlock_failed')
  const account = privateKeyToAccount(key)
  if (address && account.address.toLowerCase() !== address.toLowerCase()) throw new Error('development_keystore_address_mismatch')
  return account
}
