import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMinecraftIngress, createIngressNameAuthorizer } from '../../backend/src/discord/minecraft-ingress.mjs'
const require = createRequire(new URL('../compatibility/package.json', import.meta.url))
const protocol = require('minecraft-protocol')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function packet(state, name, params) {
  const data = protocol.createSerializer({ state, isServer: false, version: '1.21.11' }).createPacketBuffer({ name, params })
  const result = Buffer.alloc(sizeOfVarInt(data.length) + data.length)
  const offset = writeVarInt(data.length, result, 0); data.copy(result, offset); return result
}
const handshake = (version = 777, nextState = 2) => packet('handshaking', 'set_protocol', { protocolVersion: version, serverHost: 'localhost', serverPort: 25565, nextState })
const login = username => packet('login', 'login_start', { username, playerUUID: '00000000-0000-0000-0000-000000000001' })
let connects = 0, received = [], sockets = [], diagnostics = []
const backend = net.createServer(socket => { sockets.push(socket); socket.on('data', bytes => received.push(bytes)); socket.on('error', () => {}) })
backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
let authorize = async name => name === 'RealPlayer'
const ingress = createMinecraftIngress({ authorizeName: name => authorize(name), gateTimeoutMs: 150,
  onDiagnostic: event => diagnostics.push(event),
  connectUpstream: () => { connects++; return net.connect(backend.address().port, '127.0.0.1') } })
ingress.server.listen(0, '127.0.0.1'); await once(ingress.server, 'listening')
async function client() { const socket = net.connect(ingress.server.address().port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect'); return socket }
try {
  // Only local socket fixtures; no Paper/world/Discord clients are opened.
  let c = await client(); const h = handshake(); c.write(h.subarray(0, 2)); await delay(10); c.write(h.subarray(2)); await delay(10)
  assert.equal(connects, 0)
  const l = login('RealPlayer'), opaque = Buffer.from([7, 6, 5]); c.write(Buffer.concat([l, opaque])); await delay(40)
  assert.equal(connects, 1); assert.deepEqual(Buffer.concat(received), Buffer.concat([h, l, opaque])); c.destroy(); await delay(10)
  console.log('PASS reserved login gates upstream and preserves fragmented handshake/login/opaque traffic')

  authorize = async () => true
  for (const name of ['CityAgent1', 'worldbuilder', 'WorldRequester', 'Inspector', 'TaskTester', 'GateNoabcdef']) {
    c = await client(); const replies = []; c.on('data', bytes => replies.push(bytes))
    c.write(Buffer.concat([handshake(), login(name)])); await once(c, 'close')
    const bytes = Buffer.concat(replies), [readVarInt] = require('protodef').types.varint, length = readVarInt(bytes, 0)
    assert.equal(bytes.length, length.size + length.value)
    const reply = protocol.createDeserializer({ state: 'login', isServer: false, version: '1.21.11', noErrorLogging: true }).parsePacketBuffer(bytes.subarray(length.size)).data
    assert.equal(reply.name, 'disconnect'); assert.match(JSON.parse(reply.params.reason).text, /Discord \/start and \/profile/)
  }
  assert.equal(connects, 1); console.log('PASS internal and synthetic names never reach backend')
  c = await client(); const versionReplies = []; c.on('data', bytes => versionReplies.push(bytes))
  c.write(handshake(773)); await once(c, 'close')
  const unsupported = Buffer.concat(versionReplies), [readVarInt] = require('protodef').types.varint
  const versionLength = readVarInt(unsupported, 0)
  const versionReply = protocol.createDeserializer({ state: 'login', isServer: false, version: '1.21.10', noErrorLogging: true }).parsePacketBuffer(unsupported.subarray(versionLength.size)).data
  assert.equal(versionReply.name, 'disconnect'); assert.match(JSON.parse(versionReply.params.reason).text, /supports Minecraft Java 1\.21\.11/)
  assert.deepEqual(diagnostics.at(-1), { stage: 'login', protocol: 773, reason: 'unsupported_protocol' })
  assert(diagnostics.every(event => Object.keys(event).sort().join(',') === 'protocol,reason,stage'))
  assert.equal(connects, 1)
  console.log('PASS known unsupported version receives library-encoded explanation and numeric-only diagnostic')

  received = []; c = await client(); const request = packet('status', 'ping_start', {}), ping = packet('status', 'ping', { time: [0, 1] })
  const status = Buffer.concat([handshake(774, 1), request, ping]); c.write(status); await delay(35)
  assert.deepEqual(Buffer.concat(received), status)
  c.write(login('RealPlayer')); await once(c, 'close'); assert.equal(connects, 2)
  console.log('PASS standard server-list status/ping is readonly and cannot escalate to login')

  authorize = async () => { await delay(200); return true }
  c = await client(); c.write(Buffer.concat([handshake(), login('RealPlayer')])); await once(c, 'close'); await delay(80)
  assert.equal(connects, 2)
  c = await client(); c.write(Buffer.alloc(9000)); await once(c, 'close'); assert.equal(connects, 2)
  console.log('PASS bounded unauthenticated input and expired authorization fail closed')

  const directory = await mkdtemp(join(tmpdir(), 'ac-ingress-'))
  try {
    const file = join(directory, 'access.json'), expiry = Date.now() + 60000
    const row = { player_name: 'RealPlayer', principal_id: 'principal', discord_user_id: '123456789012345678', account_kind: 'local', expires_at: new Date(expiry) }
    const authorizer = createIngressNameAuthorizer({ pool: { async query(sql, args) { assert.match(sql, /JOIN ac_discord_identities/); assert.deepEqual(args, ['server', 'realplayer']); return { rows: [row] } } }, serverId: 'server', gameAccessFile: file })
    const reservation = { playerName: 'RealPlayer', principalId: row.principal_id, discordId: row.discord_user_id, accountKind: 'local', expiresAtMs: expiry }
    const save = () => writeFile(file, JSON.stringify({ schema: 'agentcity.discord-game-access.v1', reservations: { realplayer: reservation } }))
    await save(); assert.equal(await authorizer('RealPlayer'), true)
    reservation.principalId = 'other'; await save(); assert.equal(await authorizer('RealPlayer'), false)
    reservation.principalId = row.principal_id; reservation.expiresAtMs = 0; await save(); assert.equal(await authorizer('RealPlayer'), false)
    assert.equal(await authorizer('realplayer'), false)
  } finally { await rm(directory, { recursive: true }) }
  console.log('PASS exact PG principal/Discord reservation must match active native GameAccess reservation')
} finally {
  await ingress.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => backend.close(resolve))
}
