import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { openDevelopmentKeystore } from '../../backend/src/chain/development-wallets.mjs'

const ROLE_NAMES = ['issuer', 'registrar', 'publisher', 'lender', 'inspector', 'liquidity']
const readJson = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function requirePrivateFile(path) {
  const value = await lstat(path)
  assert(value.isFile() && !value.isSymbolicLink() && value.uid === process.getuid() && !(value.mode & 0o077), 'Private bank key file required')
}

export async function ensureBankOperatorSettings(rootDirectory) {
  const directory = join(rootDirectory, '.local/bank')
  const path = join(directory, 'operator-settings.json')
  const roster = await readJson(join(rootDirectory, '.local/playable-world/bank-actors.json'))
  assert.equal(roster?.schema, 'agentcity.laptop-bank-actors.v1')
  assert.equal(roster.fixture, true)
  const existing = await readJson(path)
  if (existing) {
    await requirePrivateFile(path)
    assert.equal(existing.schema, 'agentcity.bank-operator.v1')
    assert.equal(existing.operatorControlled, true)
    assert.equal(existing.serverId, roster.serverId)
    for (const role of ['borrower', 'seller', 'bidder']) {
      assert.equal(existing.actors[role].principalId, roster.actors[role].principalId)
      assert.equal(existing.actors[role].minecraftPlayerId, roster.actors[role].minecraftPlayerId)
    }
    for (const metadata of [...Object.values(existing.roles), ...Object.values(existing.actors).map(actor => actor.wallet)]) {
      await requirePrivateFile(metadata.keystore)
      await requirePrivateFile(metadata.passwordFile)
      await openDevelopmentKeystore(metadata)
    }
    return existing
  }

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const keys = join(directory, 'keys')
  await mkdir(keys, { recursive: true, mode: 0o700 })
  const passwordFile = join(keys, 'password')
  try { await writeFile(passwordFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await requirePrivateFile(passwordFile)
  const password = (await readFile(passwordFile, 'utf8')).trim()
  async function wallet(name) {
    const keystore = join(keys, name)
    let found = true
    try { await lstat(keystore) } catch (error) { if (error.code !== 'ENOENT') throw error; found = false }
    if (!found) {
      const result = spawnSync('cast', ['wallet', 'new', keys, name], {
        env: { ...process.env, CAST_PASSWORD: password }, encoding: 'utf8', timeout: 15000, maxBuffer: 8192
      })
      if (result.status !== 0) throw Error('BANK_ENCRYPTED_KEY_CREATION_FAILED')
      await chmod(keystore, 0o600)
    }
    await requirePrivateFile(keystore)
    const metadata = { keystore, passwordFile }
    const account = await openDevelopmentKeystore(metadata)
    return { ...metadata, address: account.address }
  }

  const administrator = await readJson(join(rootDirectory, '.local/public-testnet/account-settings.json'))
  assert(administrator?.keystore && administrator?.passwordFile, 'Existing testnet administrator metadata required')
  assert(administrator.chainId === undefined || administrator.chainId === 1301, 'Unichain Sepolia administrator required')
  const adminAccount = await openDevelopmentKeystore(administrator)
  const roles = { administrator: { ...administrator, address: adminAccount.address } }
  for (const role of ROLE_NAMES) roles[role] = await wallet('role-' + role)
  const actors = {}
  for (const role of ['borrower', 'seller', 'bidder']) {
    const native = roster.actors[role]
    actors[role] = { principalId: native.principalId, label: native.name, role,
      wallet: await wallet('actor-' + role), minecraftPlayerId: native.minecraftPlayerId,
      minecraftUsername: native.name, operatorControlled: true }
  }
  actors.worker = { principalId: randomUUID(), label: 'Bank Work Recipient', role: 'worker',
    wallet: await wallet('actor-worker'), operatorControlled: true, ownerPrincipalId: actors.seller.principalId }
  actors.lender = { principalId: randomUUID(), label: 'Bank Test Lender', role: 'lender',
    wallet: roles.lender, operatorControlled: true }
  const distinct = [...Object.values(roles), ...['borrower', 'seller', 'bidder', 'worker'].map(role => actors[role].wallet)]
  assert.equal(new Set(distinct.map(value => value.address.toLowerCase())).size, distinct.length)
  const result = { schema: 'agentcity.bank-operator.v1', chainId: 1301, operatorControlled: true,
    disclosure: 'All bank principals, wallets and Minecraft sessions are controlled local fixtures, not independent humans or Privy identities.',
    serverId: roster.serverId, roles, actors }
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return result
}
