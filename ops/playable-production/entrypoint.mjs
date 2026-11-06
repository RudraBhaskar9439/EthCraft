import { readFile, lstat, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const mode = process.argv[2] || 'console'
const allowed = new Set(['console', 'worker', 'admin', 'smoke'])
if (!allowed.has(mode)) throw Error('Explicit console, worker, admin or credential-free smoke mode required')
const privateFile = async path => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Mounted private files must match UID10001 and mode0600')
  return JSON.parse(await readFile(path, 'utf8'))
}
if (mode !== 'smoke') {
  const configFiles = await readdir('/app/.local/playable-testnet')
  if (configFiles.some(name => !['wallet-settings.json', 'market.json', 'enrolled-players.json'].includes(name))) throw Error('Public config directory must not contain keys, account settings or owner files')
  const credentials = await privateFile('/run/agentcity-runtime/credentials.json')
  if (Object.keys(credentials).some(name => !['appSecret', 'delegateAuthorizationPrivateKey', 'delegatePublicKey', 'ownerPublicKey'].includes(name))) throw Error('Runtime credential file contains unreviewed fields; copy only the scoped delegate and AppSecret')
  if (typeof credentials.appSecret !== 'string' || typeof credentials.delegateAuthorizationPrivateKey !== 'string' ||
      credentials.authorizationPrivateKey !== undefined || credentials.privateKey !== undefined) throw Error('Runtime credentials require app secret and delegate; owner and wallet keys are forbidden')
  const settings = JSON.parse(await readFile('/app/.local/playable-testnet/wallet-settings.json', 'utf8'))
  if (settings.credentialsFile !== '/run/agentcity-runtime/credentials.json') throw Error('Runtime credential pointer must use the isolated mounted file')
  if (mode === 'admin') {
    await privateFile('/run/agentcity-owner/owner.json')
    if (settings.adminCredentialsFile !== '/run/agentcity-owner/owner.json') throw Error('Admin CLI requires explicit separate owner pointer')
  } else {
    try { await lstat('/run/agentcity-owner/owner.json'); throw Error('Owner key must never be mounted in a runtime service') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
const command = mode === 'worker' ? ['scripts/playable_worker.mjs'] : mode === 'admin'
  ? ['scripts/playable_testnet_setup.mjs', ...process.argv.slice(3)] : ['backend/src/server.mjs']
const child = spawn(process.execPath, command, { stdio: 'inherit', env: process.env })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
