import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getAddress, zeroAddress } from 'viem'
import { createIdentityService } from './service.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = path.join(root, '.local/online-auth')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const fail = () => { throw new Error('AUTHENTICATED_MINECRAFT_SESSION_REQUIRED') }
const address = value => { try { const result = getAddress(value).toLowerCase(); if (result !== zeroAddress) return result } catch {}; fail() }
async function privateFile(file) {
  const info = await stat(file)
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) fail()
  return readFile(file, 'utf8')
}

/** Pure validation is also used by focused fixtures; callers must establish runtime ownership first. */
export function verifyMinecraftSession({ metadata, snapshot, binding, wallet, now = Date.now() }) {
  if (!snapshot?.ready || snapshot.onlineMode !== true || snapshot.directAuthentication !== true || snapshot.economicBridge !== false ||
      snapshot.serverId !== metadata.serverId || snapshot.serverBootId !== metadata.serverBootId || !UUID.test(snapshot.serverBootId) ||
      (binding.serverId !== undefined && binding.serverId !== metadata.serverId) || (binding.serverBootId !== undefined && binding.serverBootId !== metadata.serverBootId) ||
      !Number.isSafeInteger(snapshot.atMs) || snapshot.atMs > now + 2000 || now - snapshot.atMs > 5000 || !Array.isArray(snapshot.sessions)) fail()
  const entry = snapshot.sessions.find(value => value.playerUuid?.toLowerCase() === binding.playerUuid?.toLowerCase() && value.sessionId === binding.sessionId)
  if (!entry || entry.serverId !== metadata.serverId || entry.serverBootId !== metadata.serverBootId || !UUID.test(entry.playerUuid) || !UUID.test(entry.sessionId) ||
      !entry.connected || !Number.isSafeInteger(entry.expiresAtMs) || now >= entry.expiresAtMs || entry.expiresAtMs > snapshot.atMs + 30000 ||
      !Number.isSafeInteger(entry.joinedAtMs) || entry.joinedAtMs > snapshot.atMs || !Number.isSafeInteger(entry.pairedAtMs) ||
      entry.pairedAtMs < entry.joinedAtMs || entry.pairedAtMs > snapshot.atMs || address(entry.wallet) !== address(wallet)) fail()
  return { serverId: metadata.serverId, serverBootId: metadata.serverBootId, playerUuid: entry.playerUuid.toLowerCase(),
    sessionId: entry.sessionId, expiresAtMs: entry.expiresAtMs, wallet: address(entry.wallet), name: entry.name }
}

export async function readMinecraftAuthority() {
  const metadata = JSON.parse(await privateFile(path.join(base, 'active.json')))
  if (!/^[a-f0-9]{32}$/.test(metadata.id) || !/^[a-f0-9]{32}$/.test(metadata.owner) ||
      metadata.container !== 'agentcity-online-auth-' + metadata.id.slice(0, 8) || metadata.serverId !== 'agentcity-online-auth-' + metadata.id ||
      metadata.runtime !== path.join(base, metadata.id, 'server') || metadata.tokenFile !== path.join(base, metadata.id, 'api-token') || !UUID.test(metadata.serverBootId)) fail()
  const config = JSON.parse(await readFile(path.join(root, 'config/minecraft-runtime.json'), 'utf8'))
  if (metadata.javaImage !== config.java_image) fail()
  const format = '{"labels":{{json .Config.Labels}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}'
  const actual = JSON.parse((await execute('docker', ['inspect', '--format', format, metadata.container], { timeout: 5000, maxBuffer: 32768 })).stdout)
  const mounts = actual.mounts.filter(mount => mount.Destination === '/server')
  const port = (key, number) => actual.ports[key]?.length === 1 && actual.ports[key][0].HostIp === '127.0.0.1' && actual.ports[key][0].HostPort === String(number)
  if (actual.labels?.['agentcity.owner'] !== metadata.owner || actual.labels?.['agentcity.online-auth'] !== 'true' || actual.image !== metadata.javaImage || !actual.running ||
      JSON.stringify(actual.command) !== JSON.stringify(['java', '-Xms512M', '-Xmx1536M', '-jar', 'paper.jar', '--nogui']) ||
      Object.keys(actual.ports).length !== 2 || !port('25565/tcp', 25598) || !port('25579/tcp', 25599) || mounts.length !== 1 || mounts[0].Source !== metadata.runtime) fail()
  const expected = { 'paper.jar': config.artifacts.paper.sha256, 'plugins/ViaVersion.jar': config.artifacts.ViaVersion.sha256, 'plugins/ViaBackwards.jar': config.artifacts.ViaBackwards.sha256 }
  if (Object.keys(metadata.artifactHashes).sort().join(',') !== [...Object.keys(expected), 'plugins/AgentCityOnlineAuth.jar'].sort().join(',')) fail()
  for (const [relative, digest] of Object.entries(metadata.artifactHashes)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || (expected[relative] && expected[relative] !== digest) ||
        createHash('sha256').update(await readFile(path.join(metadata.runtime, relative))).digest('hex') !== digest) fail()
  }
  const token = (await privateFile(metadata.tokenFile)).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) fail()
  const response = await fetch('http://127.0.0.1:25599/status', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(7000) })
  if (!response.ok) fail()
  const bytes = await response.text()
  if (Buffer.byteLength(bytes) > 262144) fail()
  const snapshot = JSON.parse(bytes)
  if (snapshot.serverId !== metadata.serverId || snapshot.serverBootId !== metadata.serverBootId || snapshot.onlineMode !== true || snapshot.directAuthentication !== true || snapshot.ready !== true || snapshot.economicBridge !== false) fail()
  return { metadata, snapshot }
}

/** Only the owned online probe can supply live identity authority. No fixture fallback. */
export function createMinecraftIdentityService({ store, origin, clock = Date.now }) {
  async function core(binding, wallet) {
    const initial = await readMinecraftAuthority()
    verifyMinecraftSession({ ...initial, binding, wallet, now: clock() })
    return createIdentityService({ store, context: { serverId: initial.metadata.serverId, origin, chainId: 1301 }, clock,
      resolveSession: async current => {
        const authority = await readMinecraftAuthority()
        if (authority.metadata.serverId !== initial.metadata.serverId || authority.metadata.serverBootId !== initial.metadata.serverBootId) fail()
        return verifyMinecraftSession({ ...authority, binding: current, wallet, now: clock() })
      } })
  }
  return {
    async issueChallenge(binding) { return (await core(binding, binding.wallet)).issueChallenge(binding) },
    async linkWallet(binding) { return (await core(binding, binding.wallet)).linkWallet(binding) },
    async listPairedSessions() {
      const authority = await readMinecraftAuthority()
      return authority.snapshot.sessions.filter(entry => entry.wallet).map(entry => verifyMinecraftSession({ ...authority, binding: entry, wallet: entry.wallet, now: clock() }))
    }
  }
}
