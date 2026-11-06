// Actual read-only ingress verification. No reservation seeding or authorized login.
import net from 'node:net'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
const root = resolve('.'), require = createRequire(new URL('../compatibility/package.json', import.meta.url))
const protocol = require('minecraft-protocol')
const targetHost = process.env.AGENTCITY_INGRESS_TEST_HOST || '127.0.0.1'
const targetAddress = process.env.AGENTCITY_INGRESS_TEST_ADDRESS || targetHost
const targetPort = Number(process.env.AGENTCITY_INGRESS_TEST_PORT || 8796)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
assert(Number.isInteger(targetPort) && targetPort > 0 && targetPort < 65536)
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const active = JSON.parse(await readFile(join(root, '.local/playable-world/active.json'), 'utf8'))
assert.equal(active.owner, 'agentcity-playable-pilot')
const started = new Date().toISOString(), runId = randomUUID()
const directory = join(root, 'evidence/runs/minecraft-ingress', runId)
await mkdir(directory, { recursive: true })
const report = { runId, startedAt: started, status: 'fail', scope: 'Actual ingress status and denial only; no Discord-profile login or independent-human claim', target: { host: targetHost, address: targetAddress, port: targetPort }, checks: [] }
function packet(state, name, params) {
  const bytes = protocol.createSerializer({ state, isServer: false, version: '1.21.11' }).createPacketBuffer({ name, params })
  const frame = Buffer.alloc(sizeOfVarInt(bytes.length) + bytes.length)
  bytes.copy(frame, writeVarInt(bytes.length, frame, 0)); return frame
}
const handshake = (version, nextState) => packet('handshaking', 'set_protocol', { protocolVersion: version, serverHost: targetHost, serverPort: targetPort, nextState })
const files = ['personal-agents.json', 'personal-agent-tasks.json', 'plugins/AgentCity/discord-game-access.json', 'plugins/AgentCity/task-region-locks.json']
async function snapshot() {
  const result = {}
  for (const file of files) { try { result[file] = createHash('sha256').update(await readFile(join(active.runtime, file))).digest('hex') } catch (error) { if (error.code !== 'ENOENT') throw error; result[file] = null } }
  return result
}
async function connect() {
  const socket = net.connect(targetPort, targetAddress); socket.setTimeout(10000, () => socket.destroy(Error('READONLY_CHECK_TIMEOUT')))
  await once(socket, 'connect'); return socket
}
try {
  const pid = Number((await readFile(join(root, '.local/hosting/minecraft-ingress.pid'), 'utf8')).trim())
  const args = (await readFile('/proc/' + pid + '/cmdline')).toString().split('\0')
  assert(args.includes(join(root, 'backend/src/discord/minecraft-ingress.mjs')))
  const listeners = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('127.0.0.1:8796'))
  assert.equal(listeners.length, 1); assert(listeners[0].includes('pid=' + pid + ','))
  report.process = { pid, bind: '127.0.0.1:8796', privateUpstream: '127.0.0.1:25596' }
  const before = await snapshot()
  report.stateHashes = before
  assert(before['personal-agent-tasks.json']); assert(before['plugins/AgentCity/discord-game-access.json'])
  for (const version of [774, 777]) {
    if (targetHost !== '127.0.0.1') await delay(2000)
    const socket = await connect(), parser = protocol.createDeserializer({ state: 'status', isServer: false, version: '1.21.11', noErrorLogging: true })
    let buffer = Buffer.alloc(0), info
    const response = new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('data', chunk => {
        try {
          buffer = Buffer.concat([buffer, chunk]); assert(buffer.length < 1024 * 1024)
          while (buffer.length) {
            let size; try { size = readVarInt(buffer, 0) } catch (error) { if (error.partialReadError) return; throw error }
            if (buffer.length < size.size + size.value) return
            const value = parser.parsePacketBuffer(buffer.subarray(size.size, size.size + size.value)).data
            buffer = buffer.subarray(size.size + size.value)
            if (!info) { assert.equal(value.name, 'server_info'); info = JSON.parse(value.params.response) }
            else { assert.equal(value.name, 'ping'); assert.deepEqual([...value.params.time], [0, 42]); resolve(info) }
          }
        } catch (error) { reject(error) }
      })
    })
    socket.write(Buffer.concat([handshake(version, 1), packet('status', 'ping_start', {}), packet('status', 'ping', { time: [0, 42] })]))
    const result = await response; socket.destroy()
    report.checks.push({ name: 'actual status and ping echo protocol ' + version, status: 'pass', serverVersion: result.version, onlineCount: result.players?.online })
  }
  for (const username of ['CityAgent1', 'TaskTester', 'NoJoin' + runId.replaceAll('-', '').slice(0, 8)]) {
    if (targetHost !== '127.0.0.1') await delay(2000)
    const socket = await connect(); let received = 0
    const refused = new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0), complete = false
      socket.on('error', reject)
      socket.on('close', () => { if (!complete) reject(Error('DISCONNECT_PACKET_REQUIRED')) })
      socket.on('data', chunk => {
        try {
          received += chunk.length; assert(received <= 4096); bytes = Buffer.concat([bytes, chunk])
          let length; try { length = readVarInt(bytes, 0) } catch (error) { if (error.partialReadError) return; throw error }
          if (bytes.length < length.size + length.value) return
          assert.equal(bytes.length, length.size + length.value)
          const parsed = protocol.createDeserializer({ state: 'login', isServer: false, version: '1.21.11', noErrorLogging: true }).parsePacketBuffer(bytes.subarray(length.size))
          assert.equal(parsed.metadata.size, length.value); assert.equal(parsed.data.name, 'disconnect')
          const message = JSON.parse(parsed.data.params.reason).text
          assert.match(message, /Discord \/start and \/profile/)
          complete = true; resolve(message)
        } catch (error) { reject(error) }
      })
    })
    socket.write(Buffer.concat([handshake(777, 2), packet('login', 'login_start', { username, playerUUID: randomUUID() })]))
    const message = await refused; socket.destroy()
    report.checks.push({ name: username.startsWith('NoJoin') ? 'unregistered random name denied' : 'internal or fixture name denied: ' + username, status: 'pass', disconnectPacketBytes: received, message })
  }
  assert.deepEqual(await snapshot(), before)
  report.stateHashes = before
  const logs = execFileSync('docker', ['logs', '--since', started, active.container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const logins = logs.split('\n').filter(line => /logged in with entity id|joined the game|UUID of player/.test(line))
  assert.equal(logins.length, 0)
  report.checks.push({ name: 'no Paper player login and unchanged agent/task/access/lock journals', status: 'pass', paperLoginLines: 0 })
  report.authorizedDiscordLogin = 'unrun: no verified profile; no synthetic enrollment created'
  report.status = 'pass'
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (report.stateHashes) report.finalStateHashes = await snapshot()
  report.finishedAt = new Date().toISOString()
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, report: join(directory, 'report.json'), checks: report.checks.length, error: report.error }))
}
