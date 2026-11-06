import net from 'node:net'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { readDiscordConfiguration } from './settings.mjs'

// Reuse the pinned compatibility release's pre-login grammar. Play traffic is opaque.
const require = createRequire(new URL('../../../tests/compatibility/package.json', import.meta.url))
const protocol = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const parsers = Object.fromEntries(['handshaking', 'login', 'status'].map(state => [state,
  protocol.createDeserializer({ state, isServer: true, version: '1.21.11', noErrorLogging: true })]))
const forbidden = /^(?:worldbuilder|worldrequester|worldinspector|requester|inspector|cityagent\d+|.*tester\d*|gateno[a-z0-9]*|playtester|lobbytester)$/i
function disconnectFrame(version, message) {
  const payload = protocol.createSerializer({ state: 'login', isServer: true, version }).createPacketBuffer({
    name: 'disconnect', params: { reason: JSON.stringify({ text: message }) }
  })
  const frame = Buffer.alloc(sizeOfVarInt(payload.length) + payload.length)
  payload.copy(frame, writeVarInt(payload.length, frame, 0)); return frame
}
const deniedFrame = disconnectFrame('1.21.11', 'Finish Discord /start and /profile before joining; then approve this connection with /join in Discord.')
function unsupportedFrame(number) {
  const version = minecraftData.versions.pc.find(value => value.version === number && /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(value.minecraftVersion))
  if (!version) return null
  try { return disconnectFrame(version.minecraftVersion, 'This server currently supports Minecraft Java 1.21.11 or 26.3. Select a supported version, then reconnect.') }
  catch { return null } // Unknown library grammar is never guessed.
}
export const admissibleName = name => typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name) && !forbidden.test(name)

export function createIngressNameAuthorizer({ pool, serverId, gameAccessFile, now = Date.now }) {
  if (!pool || !serverId || !gameAccessFile) throw Error('INGRESS_AUTH_CONFIGURATION_REQUIRED')
  return async name => {
    if (!admissibleName(name)) return false
    const result = await pool.query(`SELECT r.player_name, r.principal_id, r.account_kind,
      r.expires_at, i.discord_user_id FROM ac_discord_name_reservations r
      JOIN ac_discord_principals p ON p.principal_id=r.principal_id
      JOIN ac_discord_identities i ON i.principal_id=p.principal_id
      WHERE r.server_id=$1 AND r.normalized_name=$2 AND r.expires_at>now()
      AND length(p.privy_subject)>0 AND i.verified_at IS NOT NULL`, [serverId, name.toLowerCase()])
    if (result.rows.length !== 1) return false
    const row = result.rows[0]
    if (row.player_name !== name || new Date(row.expires_at).getTime() <= now()) return false
    const bytes = await readFile(gameAccessFile)
    if (bytes.length > 2 * 1024 * 1024) return false
    const state = JSON.parse(bytes.toString('utf8'))
    const reservation = state.reservations?.[name.toLowerCase()]
    return state.schema === 'agentcity.discord-game-access.v1' && !!reservation &&
      reservation.playerName === name && reservation.principalId === row.principal_id &&
      reservation.discordId === row.discord_user_id && reservation.accountKind === row.account_kind &&
      Number.isSafeInteger(reservation.expiresAtMs) && reservation.expiresAtMs > now()
  }
}

// Fixed loopback endpoints; the connector seam is for isolated socket fixtures only.
export function createMinecraftIngress({ authorizeName, connectUpstream = () => net.connect(25596, '127.0.0.1'),
  gateTimeoutMs = 10000, maxConnections = 32, onDiagnostic = () => {} } = {}) {
  if (typeof authorizeName !== 'function') throw Error('INGRESS_AUTHORIZER_REQUIRED')
  const connections = new Set()
  const server = net.createServer(client => {
    if (connections.size >= maxConnections) return client.destroy()
    connections.add(client)
    let upstream, buffer = Buffer.alloc(0), held = [], total = 0, state = 'handshaking', pending = false, statusPackets = 0, protocolVersion = null, reported = false
    function diagnostic(reason) {
      if (reported) return; reported = true
      try { onDiagnostic({ stage: state, protocol: protocolVersion, reason }) } catch {}
    }
    const timer = setTimeout(() => { diagnostic('gate_timeout'); close() }, gateTimeoutMs)
    function close() { clearTimeout(timer); client.destroy(); upstream?.destroy() }
    function malformed() { diagnostic('malformed_packet'); close() }
    function deny(reason = 'reservation_required', frame = deniedFrame) {
      if (client.destroyed || client.writableEnded) return
      diagnostic(reason)
      clearTimeout(timer); pending = true
      if (!frame) return close()
      client.end(frame)
      setTimeout(close, 1000).unref()
    }
    client.on('error', close).on('close', () => { connections.delete(client); close() })
    function open(raw = false) {
      if (client.destroyed) return
      upstream = connectUpstream()
      upstream.on('error', () => { diagnostic('upstream_error'); close() }).on('close', close)
      upstream.setTimeout(120000, close)
      const connecting = setTimeout(close, 5000)
      upstream.once('connect', () => {
        clearTimeout(connecting)
        if (client.destroyed) return close()
        if (raw) {
          clearTimeout(timer); client.removeListener('data', receive)
          for (const bytes of held) upstream.write(bytes)
          if (buffer.length) upstream.write(buffer)
          held = []; buffer = Buffer.alloc(0)
          client.pipe(upstream)
        } else { for (const bytes of held) upstream.write(bytes); held = [] }
        upstream.pipe(client)
      })
      upstream.once('close', () => clearTimeout(connecting))
    }
    function forward(frame) { if (upstream && !upstream.connecting) upstream.write(frame); else held.push(frame) }
    function receive(chunk) {
      try {
        total += chunk.length
        if (total > 8192) { diagnostic('input_limit'); return close() }
        buffer = Buffer.concat([buffer, chunk])
        if (pending) return
        while (buffer.length) {
          let length
          try { length = readVarInt(buffer, 0) } catch (error) {
            if (error.partialReadError && buffer.length < 3) return
            throw error
          }
          if (length.size > 3 || length.value < 1 || length.value > 4096 || sizeOfVarInt(length.value) !== length.size) return malformed()
          if (buffer.length < length.size + length.value) return
          const frame = buffer.subarray(0, length.size + length.value), payload = frame.subarray(length.size)
          buffer = buffer.subarray(frame.length)
          const parsed = parsers[state].parsePacketBuffer(payload)
          if (parsed.metadata.size !== payload.length) return malformed()
          const { name, params } = parsed.data
          if (state === 'handshaking') {
            protocolVersion = Number.isSafeInteger(params.protocolVersion) ? params.protocolVersion : null
            if (name !== 'set_protocol' || ![1, 2].includes(params.nextState) || typeof params.serverHost !== 'string' || params.serverHost.length > 255 || /[\x00-\x1f]/.test(params.serverHost)) return malformed()
            if (params.nextState === 2 && ![774, 777].includes(params.protocolVersion)) { state = 'login'; return deny('unsupported_protocol', unsupportedFrame(protocolVersion)) }
            held.push(frame); state = params.nextState === 1 ? 'status' : 'login'
            if (state === 'status') open()
          } else if (state === 'status') {
            if (statusPackets === 0 ? name !== 'ping_start' : statusPackets !== 1 || name !== 'ping') return malformed()
            statusPackets++; forward(frame)
          } else {
            if (name !== 'login_start') return malformed()
            if (!admissibleName(params.username)) return deny('name_not_permitted')
            held.push(frame); pending = true
            Promise.resolve().then(() => authorizeName(params.username)).then(approved => {
              if (approved === true && !client.destroyed) open(true); else deny()
            }).catch(() => deny('authorization_unavailable'))
            return
          }
        }
      } catch { diagnostic('malformed_packet'); close() }
    }
    client.on('data', receive)
  })
  return { server, listen: (port = 8796) => new Promise((resolve, reject) => {
    if (![8796, 25565].includes(port)) return reject(Error('INGRESS_LOOPBACK_PORT_NOT_ALLOWED'))
    server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()) })
  }), close: async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const settings = await readDiscordConfiguration(root, { required: true, credentials: false })
  const environment = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  const active = JSON.parse(await readFile(join(root, '.local/playable-world/active.json'), 'utf8'))
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: environment.databaseUrl, max: 3 })
  const authorizeName = createIngressNameAuthorizer({ pool, serverId: settings.serverId,
    gameAccessFile: join(active.runtime, 'plugins/AgentCity/discord-game-access.json') })
  const listeners = [8796, 25565].map(port => ({ port, ingress: createMinecraftIngress({ authorizeName,
    onDiagnostic: event => console.log(JSON.stringify({ event: 'minecraft_ingress_refusal', ...event })) }) }))
  try { for (const { port, ingress } of listeners) await ingress.listen(port) }
  catch (error) { await Promise.allSettled(listeners.map(({ ingress }) => ingress.close())); await pool.end(); throw error }
  console.log('Minecraft ingress ready on loopback8796 and25565; private upstream25596; Discord connection approval remains required.')
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await Promise.all(listeners.map(({ ingress }) => ingress.close())); await pool.end()
  })
}
