import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'

const root = resolve(new URL('../..', import.meta.url).pathname)
const nbt = createRequire(import.meta.url)('../compatibility/node_modules/prismarine-nbt')
const directory = join(root, 'evidence/runs/bank-native-delivery', randomUUID())
const report = {
  status: 'fail', observedAt: new Date().toISOString(),
  scope: 'Read-only saved actual Paper player NBT after native delivery saveData; no session changes or independent human qualification.',
  observations: [], checks: [], publicTransactions: 0, paidModelCalls: 0,
}

// Match Java TreeMap ordering. Locale collation changes the item fingerprint.
function sortedTag(tag) {
  if (tag.type === 'compound') return { ...tag, value: Object.fromEntries(
    Object.entries(tag.value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => [key, sortedTag(value)])) }
  if (tag.type === 'list') return { ...tag, value: { ...tag.value,
    value: tag.value.value.map(value => sortedTag({ type: tag.value.type, value }).value) } }
  return tag
}

function fingerprint(item, dataVersion) {
  const value = { ...item, DataVersion: dataVersion }
  delete value.Slot
  const serialized = nbt.writeUncompressed(sortedTag({ type: 'compound', name: '', value }))
  const header = Buffer.alloc(9)
  header.writeUInt8(1, 0)
  header.writeUInt32BE(1, 1)
  header.writeUInt32BE(serialized.length, 5)
  return createHash('sha256').update('agentcity.item.canonical_nbt_v1\0')
    .update(header).update(serialized).digest('hex')
}

try {
  const active = JSON.parse(await readFile(join(root, '.local/playable-world/active.json'), 'utf8'))
  const roster = JSON.parse(await readFile(join(root, '.local/playable-world/bank-actors.json'), 'utf8'))
  const progress = JSON.parse(await readFile(join(root, '.local/bank/public-demo-progress.json'), 'utf8'))
  assert.equal(active.deploymentOwner, 'agentcity-laptop-bank')
  assert.equal(roster.serverId, active.serverId)
  const expected = {
    borrower: { receipt: progress.observations.purchasedSwordDelivery, originalOwner: 'BankSeller' },
    bidder: { receipt: progress.observations.originalSwordDelivery, originalOwner: 'BankBorrower' },
  }
  for (const role of ['borrower', 'seller', 'bidder']) {
    const actor = roster.actors[role]
    const file = join(active.runtime, 'agentcity_laptop_bank/players/data', actor.minecraftPlayerId + '.dat')
    const { parsed } = await nbt.parse(await readFile(file))
    const items = parsed.value.Inventory.value.value
    const entries = items.map(item => ({ ...nbt.simplify({ type: 'compound', value: item }),
      fingerprint: fingerprint(item, parsed.value.DataVersion) }))
    report.observations.push({ role, playerId: actor.minecraftPlayerId,
      savedAt: (await stat(file)).mtime.toISOString(), entries })
    if (role === 'seller') {
      assert.equal(entries.length, 0, 'Seller must retain no equipment duplicate')
      continue
    }
    const { receipt, originalOwner } = expected[role]
    assert.equal(receipt.claimed, true)
    assert.equal(receipt.ownerId, actor.principalId)
    assert.equal(receipt.playerId, actor.minecraftPlayerId)
    assert.equal(entries.length, 1)
    const item = entries[0]
    assert.equal(item.id, 'minecraft:diamond_sword')
    assert.equal(item.count, 1)
    assert.equal(item.components['minecraft:damage'], 7)
    assert.equal(item.components['minecraft:enchantments']['minecraft:sharpness'], 2)
    assert.equal(item.components['minecraft:custom_data'].PublicBukkitValues['agentcityworldfixture:native_proof'], originalOwner)
    assert.equal(item.fingerprint, receipt.fingerprint)
  }
  report.serverId = active.serverId
  report.checks.push('Bidder holds exactly the auctioned original borrower sword',
    'Borrower holds exactly the purchased seller sword; no original duplicate',
    'Seller inventory is empty', 'Both full canonical NBT fingerprints match actual delivery receipts')
  report.status = 'pass'
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  report.sources = { 'tests/bank/native-delivery.mjs': createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length,
    evidence: join(directory, 'report.json'), error: report.error }))
}
