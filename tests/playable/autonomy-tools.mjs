// Disclosed native-effect fixtures. These do not establish a live Minecraft run.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { compileTaskPlan, createTaskTools } from '../../backend/src/playable/task-tools.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = join(root, 'evidence/runs/playable-autonomy-tools', randomUUID())
await mkdir(directory, { recursive: true })
const ownerId = '11111111-1111-4111-8111-111111111111'
const region = { slotName: 'CityAgent2', ownerId, world: 'fixture_only', min: [-47, 64, 2], max: [-36, 71, 13], origin: [-45, 64, 4], sourceChest: [-47, 64, 2], destinationChest: [-47, 64, 4] }
const copy = value => structuredClone(value)
const report = { status: 'fail', scope: 'Focused disclosed native-effect fixtures; no live Minecraft, human participation, wallet or chain claims', checks: [], sourceSha256: createHash('sha256').update(await readFile(new URL('../../backend/src/playable/task-tools.mjs', import.meta.url))).digest('hex') }
const pass = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
function fixture() {
  const world = { inventory: {}, source: {}, destination: {}, blocks: {}, places: 0, digs: 0, crafts: 0, withdraws: 0, deposits: 0 }
  let losePlace = false, loseGather = false
  const adapter = {
    inventory: () => copy(world.inventory), block: position => world.blocks[position.join(',')] || 'air',
    chestCounts: async position => copy(position.join(',') === region.sourceChest.join(',') ? world.source : world.destination),
    withdraw: async (position, item, count) => { world.withdraws++; world.source[item] = (world.source[item] || 0) - count; world.inventory[item] = (world.inventory[item] || 0) + count },
    deposit: async (position, item, count) => { world.deposits++; world.inventory[item] -= count; world.destination[item] = (world.destination[item] || 0) + count },
    place: async (position, item) => { world.places++; world.inventory[item]--; world.blocks[position.join(',')] = item; if (losePlace) { losePlace = false; throw Error('fixture lost placement reply') } },
    craft: async (item, batches, recipe) => { world.crafts++; world.inventory[recipe.ingredient] -= batches * recipe.input; world.inventory[item] = (world.inventory[item] || 0) + batches * recipe.output },
    gather: async (position, item) => { world.digs++; world.blocks[position.join(',')] = 'air'; world.inventory[item] = (world.inventory[item] || 0) + 1; if (loseGather) { loseGather = false; throw Error('fixture lost harvest reply') } },
    pickup: async () => {}
  }
  return { world, adapter, losePlacement: () => { losePlace = true }, loseHarvest: () => { loseGather = true } }
}
const slot = () => ({ name: region.slotName, ownerId, ownerName: 'DisclosedFixture', bot: {}, generation: 0, mode: 'wait' })
const engine = (name, fake, options = {}) => createTaskTools({ rootDirectory: root, runtimeDirectory: join(directory, name), taskRegions: [region], ownerReady: () => true, adapterFactory: async () => fake.adapter, ...options })
const run = async (tools, actor, plan, operationId = randomUUID()) => { await tools.start({ slot: actor, plan, operationId }); await tools.idle(); return operationId }
try {
  const arch = { action: 'build_structure', offset: [5, 0, 6], material: 'oak_planks', placements: [
    ...[0, 1].flatMap(y => [{ offset: [0, y, 0] }, { offset: [2, y, 0], material: 'cobblestone' }]),
    ...[0, 1, 2].map(x => ({ offset: [x, 2, 0] }))] }
  const compiled = compileTaskPlan(arch, region)
  assert.equal(compiled.placements.length, 7); assert.deepEqual(compiled.bill, { oak_planks: 5, cobblestone: 2 })
  assert.equal(compileTaskPlan({ action: 'build_structure', structure: 'house', width: 4, depth: 4, height: 4 }, region).placements.length, 54)
  assert.throws(() => compileTaskPlan({ ...arch, offset: [-1, 0, 6] }, region), /access strip/)
  assert.throws(() => compileTaskPlan({ ...arch, placements: [{ offset: [0, 0, 0] }, { offset: [0, 0, 0] }] }, region), /same cell/)
  assert.throws(() => compileTaskPlan({ ...arch, offset: [10, 0, 6] }, region), /authorized plot/)
  pass('explicit mixed custom arch and procedural fallback compile with bounded bill and refuse reserved foreign or duplicate cells')
  const compact = { action: 'build_structure', structure: 'custom', offset: [5, 0, 6], width: 3, depth: 1, height: 3,
    parts: [{ min: [0, 0, 0], max: [2, 2, 0] }, { min: [0, 2, 0], max: [2, 2, 0] }],
    voids: [{ min: [1, 0, 0], max: [1, 1, 0] }], material: 'oak_planks' }
  const compactArch = compileTaskPlan(compact, region)
  assert.equal(compactArch.placements.length, 7); assert.deepEqual(compactArch.bill, { oak_planks: 7 })
  assert.deepEqual(compactArch.clearances, [[-39, 64, 10], [-39, 65, 10]])
  assert.equal(Object.hasOwn(compiled, 'clearances'), false, 'Explicit legacy plans keep their original binding shape')
  assert.deepEqual(compactArch.placements.map(block => block.position), compiled.placements.map(block => block.position))
  assert.throws(() => compileTaskPlan({ ...compact, height: 4 }, region), /bounding box/)
  assert.throws(() => compileTaskPlan({ ...compact, parts: [...compact.parts, { min: [0, 0, 0], max: [0, 0, 0], material: 'cobblestone' }] }, region), /disagree/)
  const occupiedVoid = fixture(), occupiedOwner = slot()
  occupiedVoid.world.source.oak_planks = 7; occupiedVoid.world.blocks['-39,64,10'] = 'stone'
  const occupiedTools = await engine('occupied-opening', occupiedVoid)
  await run(occupiedTools, occupiedOwner, compact)
  assert.equal(occupiedTools.status(ownerId)[0].status, 'blocked')
  assert.match(occupiedTools.status(ownerId)[0].message, /opening is occupied/)
  assert.equal(occupiedVoid.world.withdraws, 0); assert.equal(occupiedVoid.world.places, 0); assert.equal(occupiedVoid.world.digs, 0)
  assert.equal(occupiedVoid.world.source.oak_planks, 7); assert.equal(occupiedVoid.world.blocks['-39,64,10'], 'stone')
  const parameterizedArch = compileTaskPlan({ action: 'build_structure', structure: 'arch', width: 5, depth: 2, height: 4 }, region)
  assert.equal(parameterizedArch.placements.length, 22)
  assert.equal(parameterizedArch.clearances.length, 18)
  const proceduralSmall = { action: 'build_structure', structure: 'arch', width: 3, depth: 1, height: 3, offset: [5, 0, 6] }
  assert.deepEqual(compileTaskPlan(proceduralSmall, region).placements, compactArch.placements)
  const occupiedArch = fixture(), archOwner = slot()
  occupiedArch.world.source.oak_planks = 7; occupiedArch.world.blocks['-39,64,10'] = 'stone'
  const archTools = await engine('occupied-procedural-arch', occupiedArch)
  await run(archTools, archOwner, proceduralSmall)
  assert.equal(archTools.status(ownerId)[0].status, 'blocked'); assert.equal(occupiedArch.world.withdraws, 0); assert.equal(occupiedArch.world.places, 0)
  pass('compact geometry and parameterized arch preserve declared empty openings and refuse occupied cells before consuming materials')

  const mixed = fixture(), mixedOwner = slot(), mixedId = randomUUID()
  mixed.world.inventory = { oak_planks: 1, oak_log: 1, cobblestone: 1 }; mixed.world.source.oak_planks = 1
  const mixedPlan = { action: 'build_structure', placements: [{ offset: [0, 0, 0] }, { offset: [1, 0, 0] }, { offset: [2, 0, 0] }, { offset: [3, 0, 0], material: 'cobblestone' }] }
  let tools = await engine('mixed', mixed)
  mixed.losePlacement(); await run(tools, mixedOwner, mixedPlan, mixedId)
  assert.equal(tools.status(ownerId)[0].status, 'reconciliation_required')
  tools = await engine('mixed', mixed); await run(tools, mixedOwner, mixedPlan, mixedId)
  assert.equal(tools.status(ownerId)[0].status, 'complete')
  assert.equal(mixed.world.places, 4); assert.equal(mixed.world.crafts, 1); assert.equal(mixed.world.withdraws, 1)
  assert.deepEqual(mixed.world.inventory, { oak_planks: 3, oak_log: 0, cobblestone: 0 })
  assert.equal(mixed.world.source.oak_planks, 0)
  await run(tools, mixedOwner, mixedPlan, mixedId); assert.equal(mixed.world.places, 4)
  pass('mixed build uses carried stock first safe real-ingredient recipe and exact chest shortfall; lost placement resumes without extra effects')

  const gathering = fixture(), gatheringOwner = slot(), gatherId = randomUUID()
  gathering.world.blocks['-40,64,10'] = 'oak_planks'; gathering.world.blocks['-39,64,10'] = 'oak_planks'
  const gatherPlan = { action: 'gather', item: 'oak_planks', count: 2, positions: [[5, 0, 6], [6, 0, 6]] }
  tools = await engine('gather', gathering)
  gathering.loseHarvest(); await run(tools, gatheringOwner, gatherPlan, gatherId)
  assert.equal(tools.status(ownerId)[0].status, 'reconciliation_required')
  tools = await engine('gather', gathering); await run(tools, gatheringOwner, gatherPlan, gatherId)
  assert.equal(tools.status(ownerId)[0].status, 'complete'); assert.equal(gathering.world.digs, 2)
  assert.equal(gathering.world.inventory.oak_planks, 2)
  await run(tools, gatheringOwner, gatherPlan, gatherId); assert.equal(gathering.world.digs, 2)
  assert.throws(() => compileTaskPlan({ ...gatherPlan, positions: [[-2, 0, -2], [0, 0, 0]] }, region), /foundations|access strip/)
  pass('native harvest fixture reconciles lost reply from exact block and picked-up item delta without digging twice or touching protected access')

  const craftId = await run(tools, gatheringOwner, { action: 'craft', item: 'sticks', count: 4 })
  assert.equal(gathering.world.inventory.stick, 4); assert.equal(gathering.world.inventory.oak_planks, 0)
  const deliverId = await run(tools, gatheringOwner, { action: 'deliver', item: 'stick', count: 4 })
  assert.equal(gathering.world.destination.stick, 4); assert.equal(gathering.world.inventory.stick, 0)
  assert.equal(gathering.world.withdraws, 0); assert.equal(gathering.world.crafts, 1); assert.equal(gathering.world.deposits, 1)
  await run(tools, gatheringOwner, { action: 'craft', item: 'sticks', count: 4 }, craftId)
  await run(tools, gatheringOwner, { action: 'deliver', item: 'stick', count: 4 }, deliverId)
  assert.equal(gathering.world.crafts, 1); assert.equal(gathering.world.deposits, 1)
  pass('gathered two planks craft four canonical stick then deliver carried output from empty source chest exactly once')

  const observed = fixture(), observer = slot(), lockEvents = []
  observed.world.source = { oak_planks: 9 }; observed.world.destination = { stick: 4 }; observed.world.inventory = { dirt: 1 }
  observed.world.blocks['-40,64,10'] = 'oak_log'
  let locked = false
  const originalRead = observed.adapter.chestCounts
  observed.adapter.chestCounts = async position => { assert.equal(locked, true); return originalRead(position) }
  tools = await engine('inspect', observed, { onTaskLock: async (actor, task, state) => { locked = state.locked; lockEvents.push(locked) } })
  const before = copy(observed.world), snapshot = await tools.inspect(observer)
  assert.deepEqual(snapshot.inventory, { dirt: 1 }); assert.deepEqual(snapshot.source, { oak_planks: 9 }); assert.deepEqual(snapshot.destination, { stick: 4 })
  assert(snapshot.resources.some(resource => resource.item === 'oak_log')); assert(Number.isFinite(Date.parse(snapshot.observedAt)))
  assert.equal(tools.unfinished(ownerId), undefined); assert.deepEqual(lockEvents, [true, false]); assert.deepEqual(observed.world, before)
  pass('fresh read-only inspection records actual fixture stock inventory and resources under short own plot lock with no material mutation or unfinished task')
  report.status = 'pass'
} catch (error) { report.error = error.message; process.exitCode = 1 }
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: join(directory, 'report.json'), error: report.error }))
