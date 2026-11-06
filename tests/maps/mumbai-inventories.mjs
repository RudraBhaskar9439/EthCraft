// Read-only post-rollout comparison with the last verified marketplace receipts.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'

const root = resolve(new URL('../..', import.meta.url).pathname)
const nbt = createRequire(new URL('../compatibility/package.json', import.meta.url))('prismarine-nbt')
const expectedPath = 'evidence/runs/marketplace-native-delivery/50f7f023-a03d-422a-b28e-4baad7032b1f/report.json'
const expected = JSON.parse(await readFile(join(root, expectedPath), 'utf8'))
const active = JSON.parse(await readFile(join(root, '.local/playable-world/active.json'), 'utf8'))
const deployment = JSON.parse(await readFile(join(active.runtime, 'plugins/AgentCity/deployment.json'), 'utf8'))
const actors = JSON.parse(await readFile(join(root, '.local/playable-world/bank-actors.json'), 'utf8'))
const directory = join(root, 'evidence/runs/mumbai-inventories', randomUUID())
const report = { status: 'fail', recordedAt: new Date().toISOString(), scope: 'Actual saved full-NBT inventories after map rollout; no sessions, movement, grants, signatures or transactions.',
  expectedReport: expectedPath, observations: [], checks: [], publicTransactions: 0, walletSignatures: 0, paidModelCalls: 0 }
const hash = value => createHash('sha256').update(value).digest('hex')

// Same canonical_nbt_v1 envelope as the native Java item-custody implementation.
function sorted(tag) {
  if (tag.type === 'compound') return { ...tag, value: Object.fromEntries(Object.entries(tag.value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => [name, sorted(value)])) }
  if (tag.type === 'list') return { ...tag, value: { ...tag.value, value: tag.value.value.map(value => sorted({ type: tag.value.type, value }).value) } }
  return tag
}
function fingerprint(item, version) {
  const value = { ...item, DataVersion: version }; delete value.Slot
  const data = nbt.writeUncompressed(sorted({ type: 'compound', name: '', value }))
  const header = Buffer.alloc(9); header.writeUInt8(1); header.writeUInt32BE(1, 1); header.writeUInt32BE(data.length, 5)
  return createHash('sha256').update('agentcity.item.canonical_nbt_v1\0').update(header).update(data).digest('hex')
}
try {
  assert.equal(expected.status, 'pass')
  assert.equal(active.serverId, expected.serverId)
  assert.equal(deployment.serverId, expected.serverId)
  assert.equal(actors.serverId, expected.serverId)
  for (const role of ['borrower', 'seller', 'bidder']) {
    const actor = actors.actors[role], previous = expected.observations.find(value => value.role === role)
    assert.equal(actor.minecraftPlayerId, previous.playerId)
    const raw = await readFile(join(active.runtime, deployment.world, 'players/data', actor.minecraftPlayerId + '.dat'))
    const { parsed } = await nbt.parse(raw)
    const entries = parsed.value.Inventory.value.value.map(item => ({ ...nbt.simplify({ type: 'compound', value: item }), fingerprint: fingerprint(item, parsed.value.DataVersion) }))
    assert.deepEqual(entries, previous.entries, 'Original actor inventory changed: ' + role)
    report.observations.push({ role, playerId: actor.minecraftPlayerId, savedFileSha256: hash(raw), entries })
    report.checks.push({ name: role + ' full item fingerprints and inventory match the prior native delivery proof', status: 'pass' })
  }
  report.status = 'pass'; report.serverId = expected.serverId
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  report.sourceSha256 = hash(await readFile(new URL(import.meta.url)))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(directory, 'report.json'), error: report.error }))
}
