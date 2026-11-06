import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compileTaskPlan, createTaskTools, NativeTaskAdapter } from '../../backend/src/playable/task-tools.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'agentcity-native-tasks-'))
const ownerId = '11111111-1111-4111-8111-111111111111'
const region = { slotName: 'CityAgent1', ownerId, world: 'agentcity_play', min: [20, 80, 20], max: [35, 92, 35], origin: [24, 81, 24], sourceChest: [21, 81, 21], destinationChest: [21, 81, 23] }
const copy = value => JSON.parse(JSON.stringify(value))
function fixture(stock = 32) {
  const world = { inventory: {}, source: { oak_planks: stock }, destination: {}, blocks: {}, withdraws: 0, deposits: 0, placements: 0 }
  let loseWithdraw = false, losePlace = false
  const adapter = {
    inventory: () => copy(world.inventory),
    chestCounts: async position => copy(position.join(',') === region.sourceChest.join(',') ? world.source : world.destination),
    block: position => world.blocks[position.join(',')] || 'air',
    withdraw: async (position, item, count) => {
      world.withdraws++; world.source[item] = (world.source[item] || 0) - count; world.inventory[item] = (world.inventory[item] || 0) + count
      if (loseWithdraw) { loseWithdraw = false; throw Error('lost native withdrawal reply') }
    },
    deposit: async (position, item, count) => { world.deposits++; world.inventory[item] -= count; world.destination[item] = (world.destination[item] || 0) + count },
    place: async (position, item) => {
      world.placements++; world.inventory[item]--; world.blocks[position.join(',')] = item
      if (losePlace) { losePlace = false; throw Error('lost native placement reply') }
    }
  }
  return { world, adapter, loseWithdrawal: () => { loseWithdraw = true }, losePlacement: () => { losePlace = true } }
}
const slot = () => ({ name: 'CityAgent1', ownerId, ownerName: 'Ruddy', bot: {}, generation: 0, mode: 'wait' })
async function tools(name, fake, options = {}) {
  return createTaskTools({ rootDirectory: temporary, runtimeDirectory: join(temporary, name), taskRegions: [region], ownerReady: () => true, adapterFactory: async () => fake.adapter, ...options })
}
try {
  const require = createRequire(import.meta.url), rootDirectory = fileURLToPath(new URL('../../', import.meta.url))
  const dependencies = join(rootDirectory, 'tests/compatibility/node_modules')
  const registry = require(join(dependencies, 'prismarine-registry'))('1.21.11')
  const { Movements } = require(join(dependencies, 'mineflayer-pathfinder'))
  const previousMovements = { retained: true }
  const navigationBot = { registry, pathfinder: { movements: previousMovements,
    setMovements(value) { this.movements = value } } }
  const nativeNavigation = new NativeTaskAdapter({ bot: navigationBot, rootDirectory,
    region: { min: [2, 64, 20], max: [13, 71, 33] }, playSpawn: { x: 0, y: 64, z: 0 }, check: () => {} })
  const taskMovements = navigationBot.pathfinder.movements
  taskMovements.getMoveForward = (node, direction, neighbors) => neighbors.push({ x: node.x + direction.x, z: node.z + direction.z })
  for (const method of ['getMoveJumpUp', 'getMoveDropDown', 'getMoveDown', 'getMoveUp']) taskMovements[method] = () => {}
  assert.deepEqual(taskMovements.getNeighbors({ x: 13, y: 64, z: 32 }), [
    { x: 12, z: 32 }, { x: 14, z: 32 }, { x: 13, z: 31 }, { x: 13, z: 33 }
  ])
  assert.equal(taskMovements.canDig, false); assert.equal(taskMovements.allow1by1towers, false)
  assert.equal(taskMovements.allowParkour, false); assert.deepEqual(taskMovements.scafoldingBlocks, [])
  assert.equal(new Movements(navigationBot).getMoveDiagonal, Movements.prototype.getMoveDiagonal)
  assert.notEqual(taskMovements.getMoveDiagonal, Movements.prototype.getMoveDiagonal)
  nativeNavigation.restore()
  assert.equal(navigationBot.pathfinder.movements, previousMovements)
  console.log('PASS task-local pathfinding generates only cardinal neighbors, cannot dig or scaffold, and restores the previous movement policy')

  class Position {
    constructor(x, y, z) { Object.assign(this, { x, y, z }) }
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z) }
  }
  const navigation = Object.create(NativeTaskAdapter.prototype), route = []
  navigation.Vec3 = Position
  navigation.region = { min: [-47, 64, 2], max: [-36, 71, 13] }
  navigation.approach = [-36, 64, 8]
  let closed = 0
  const observedBlock = position => position.x === -47 && position.y === 64 && position.z === 2 ? { name: 'chest', boundingBox: 'block' } :
    position.y === 63 ? { name: 'stone', boundingBox: 'block' } :
      position.x >= -45 && position.x <= -42 && position.z >= 4 && position.z <= 7 && position.y >= 64 && position.y <= 67 ? { name: 'oak_planks', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  navigation.bot = { entity: { position: new Position(-40.687, 64, 4.402) }, blockAt: observedBlock, openChest: async () => ({ close: async () => { closed++ } }) }
  navigation.walk = async position => { route.push([...position]); navigation.bot.entity.position = new Position(position[0] + .5, position[1], position[2] + .5) }
  navigation.moveNear = async () => {}
  assert.equal(await navigation.chest([-47, 64, 2], async () => 42), 42)
  assert.deepEqual(route, [[-41, 64, 3], [-46, 64, 3]])
  assert.equal(closed, 1)
  route.length = 0; navigation.bot.entity.position = new Position(-44.762, 64, 8.319)
  await navigation.chest([-47, 64, 2], async () => 42)
  assert.deepEqual(route, [[-37, 64, 8], [-37, 64, 3], [-46, 64, 3]])
  assert.equal(closed, 2)
  for (const obstruction of [null, { name: 'stone', boundingBox: 'block' }]) {
    route.length = 0; navigation.bot.entity.position = new Position(-44.762, 64, 8.319)
    navigation.bot.blockAt = position => position.x === -39 && position.y === 64 && position.z === 8 ? obstruction : observedBlock(position)
    await assert.rejects(navigation.chest([-47, 64, 2], async () => 42), /blocked or not loaded/)
    assert.equal(route.length, 0); assert.equal(closed, 2)
  }
  console.log('PASS native chest approach selects observed-clear cardinal detours around retained structures and refuses unknown or blocked lanes without opening stock')
  const fake = fixture()
  let engine = await tools('platform', fake)
  const owner = slot(), operationId = randomUUID(), plan = { action: 'build_platform', width: 2, depth: 3, material: 'oak_planks' }
  await engine.start({ slot: owner, plan, operationId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'complete')
  assert.equal(fake.world.placements, 6); assert.equal(fake.world.withdraws, 1)
  assert.equal(fake.world.source.oak_planks, 26); assert.equal(fake.world.inventory.oak_planks, 0)
  await engine.start({ slot: owner, plan, operationId }); await engine.idle()
  assert.equal(fake.world.placements, 6); assert.equal(fake.world.withdraws, 1)
  const checkpoint = JSON.parse(await readFile(join(temporary, 'platform/personal-agent-tasks.json'), 'utf8'))
  assert.equal(Object.keys(checkpoint.tasks[0].receipts).length, 7)
  assert.throws(() => compileTaskPlan({ action: 'deliver', item: 'oak_planks', count: 1, source: [0, 0, 0] }, region), /registered/)
  assert.throws(() => compileTaskPlan(plan), /registered/)
  const forbidden = await createTaskTools({ runtimeDirectory: join(temporary, 'forbidden'), taskRegions: [{ ...region, ownerId: '22222222-2222-4222-8222-222222222222' }] })
  await assert.rejects(forbidden.start({ slot: owner, plan, operationId: randomUUID() }), /authorized/)
  console.log('PASS real-effect fixture platform consumes exact stock, checks blocks, refuses foreign chests/plots and replays without new effects')

  const shortage = fixture(0), shortageOwner = slot()
  engine = await tools('shortage', shortage)
  const smallPlan = { action: 'build_platform', width: 3, depth: 3, material: 'oak_planks' }
  await engine.start({ slot: shortageOwner, plan: smallPlan, operationId: randomUUID() }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'blocked')
  assert.equal(shortage.world.withdraws, 0); assert.equal(shortage.world.placements, 0)
  shortage.world.source.oak_planks = 9
  await engine.start({ slot: shortageOwner, plan: smallPlan, operationId: randomUUID() }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'complete')
  assert.equal(shortage.world.withdraws, 1); assert.equal(shortage.world.placements, 9)
  console.log('PASS shortage waits without creating materials; the same task resumes after actual stock arrives')

  const delivery = fixture(12), deliveryOwner = slot()
  let locked = false
  const lockEvents = []
  const locks = { onTaskLock: async (boundSlot, task, change) => {
    assert.equal(boundSlot.name, 'CityAgent1'); assert.equal(task.ownerId, ownerId)
    locked = change.locked; lockEvents.push(change.locked)
  } }
  const originalRead = delivery.adapter.chestCounts
  delivery.adapter.chestCounts = async position => { assert.equal(locked, true, 'Receiving-boundary lock must precede chest reads'); return originalRead(position) }
  engine = await tools('delivery', delivery, locks)
  const deliveryPlan = { action: 'deliver', item: 'oak_planks', count: 6 }, deliveryId = randomUUID()
  delivery.loseWithdrawal()
  await engine.start({ slot: deliveryOwner, plan: deliveryPlan, operationId: deliveryId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'reconciliation_required')
  assert.equal(delivery.world.withdraws, 1); assert.equal(delivery.world.deposits, 0)
  assert.equal(locked, true)
  assert.deepEqual(lockEvents, [true])
  engine = await tools('delivery', delivery, locks)
  await engine.start({ slot: deliveryOwner, plan: deliveryPlan, operationId: deliveryId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'complete')
  assert.equal(delivery.world.withdraws, 1); assert.equal(delivery.world.deposits, 1)
  assert.equal(delivery.world.source.oak_planks, 6); assert.equal(delivery.world.destination.oak_planks, 6); assert.equal(delivery.world.inventory.oak_planks, 0)
  assert.deepEqual(lockEvents, [true, true, false])
  assert.equal(locked, false)
  console.log('PASS lost withdrawal reply and restart reconcile the original transfer without withdrawing or delivering twice')

  const placement = fixture(4), placementOwner = slot()
  engine = await tools('placement', placement)
  const placementPlan = { action: 'build_platform', width: 2, depth: 2, material: 'oak_planks' }, placementId = randomUUID()
  placement.losePlacement()
  await engine.start({ slot: placementOwner, plan: placementPlan, operationId: placementId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'reconciliation_required')
  engine = await tools('placement', placement)
  await engine.start({ slot: placementOwner, plan: placementPlan, operationId: placementId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'complete')
  assert.equal(placement.world.placements, 4); assert.equal(placement.world.withdraws, 1)
  assert.equal(compileTaskPlan({ action: 'build_shelter', width: 4, depth: 4, material: 'oak_planks' }, region).placements.length, 54)
  console.log('PASS lost placement reply preserves its original ID and consumes one item per actual placement; shelter has a bounded material bill')

  const collection = fixture(6), collectionOwner = slot(), collectionId = randomUUID()
  engine = await tools('collection', collection)
  const collectionPlan = { action: 'collect', item: 'oak_planks', count: 4 }
  await engine.start({ slot: collectionOwner, plan: collectionPlan, operationId: collectionId }); await engine.idle()
  assert.equal(engine.status(ownerId)[0].status, 'complete')
  assert.equal(collection.world.source.oak_planks, 2); assert.equal(collection.world.inventory.oak_planks, 4)
  assert.equal(collection.world.withdraws, 1); assert.equal(collection.world.deposits, 0)
  await engine.start({ slot: collectionOwner, plan: collectionPlan, operationId: collectionId }); await engine.idle()
  assert.equal(collection.world.withdraws, 1)
  assert.throws(() => compileTaskPlan({ ...collectionPlan, source: [1, 2, 3] }, region), /registered/)
  console.log('PASS collection moves real registered stock into the owner agent inventory once, ready for an explicit sale or return')

  const binding = fixture(4), bindingOwner = slot(), bindingId = randomUUID()
  const mappedRegion = { ...region, min: { x: 20, y: 80, z: 20 }, max: { x: 35, y: 92, z: 35 } }
  engine = await tools('binding', binding, { taskRegions: [mappedRegion] })
  await engine.start({ slot: bindingOwner, plan: placementPlan, operationId: bindingId }); await engine.idle()
  const bindingFile = join(temporary, 'binding/personal-agent-tasks.json')
  const legacy = JSON.parse(await readFile(bindingFile, 'utf8'))
  delete legacy.tasks[0].hashVersion
  const originalRawHash = createHash('sha256').update(JSON.stringify({ plan: legacy.tasks[0].plan, region: mappedRegion })).digest('hex')
  legacy.tasks[0].planHash = originalRawHash
  await writeFile(bindingFile, JSON.stringify(legacy))
  engine = await tools('binding', binding, { taskRegions: [mappedRegion] })
  const migrated = JSON.parse(await readFile(bindingFile, 'utf8')).tasks[0]
  assert.equal(migrated.planHash, originalRawHash, 'Do not rewrite a historical raw binding')
  assert.equal(migrated.bindingMigration.fromRawHash, originalRawHash)
  assert.equal(migrated.canonicalPlanHash, migrated.bindingMigration.canonicalHash)
  const reorderedRegion = Object.fromEntries(Object.entries(mappedRegion).reverse())
  reorderedRegion.min = { z: 20, y: 80, x: 20 }; reorderedRegion.max = { y: 92, x: 35, z: 35 }
  engine = await tools('binding', binding, { taskRegions: [reorderedRegion] })
  assert.match(await engine.start({ slot: bindingOwner, plan: placementPlan, operationId: bindingId }), /already complete/)
  assert.equal(binding.world.withdraws, 1); assert.equal(binding.world.placements, 4)
  engine = await tools('binding', binding, { taskRegions: [{ ...reorderedRegion, sourceChest: [22, 81, 21] }] })
  await assert.rejects(engine.start({ slot: bindingOwner, plan: placementPlan, operationId: bindingId }), /different terms/)
  assert.equal(binding.world.withdraws, 1)
  console.log('PASS verified legacy bindings preserve raw history, accept reordered region objects after restart and refuse changed chest coordinates')
  const cancellation = fixture(), cancelledOwner = slot()
  cancelledOwner.bot = { inventory: { items: () => Object.entries(cancellation.world.inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) } }
  const unlocks = []
  const cancelEngine = await tools('explicit-cancel', cancellation, { onTaskLock: async (_, task, options) => unlocks.push({ id: task.id, ...options }) })
  const blocked = { id: 'blocked-no-resource', operationId: 'old-gather-request', ownerId, slotName: cancelledOwner.name, status: 'blocked', completed: [], receipts: {}, pending: null, plan: { action: 'gather', item: 'oak_planks', count: 2 }, message: 'No loose resources.' }
  cancelEngine.state.tasks.push(blocked); await cancelEngine.save()
  blocked.pending = { id: 'uncertain-native-effect' }
  await assert.rejects(cancelEngine.cancelZeroEffect(cancelledOwner, 'cancel-1'), /native operation/)
  blocked.pending = null; blocked.receipts = { actual: { before: {}, after: {} } }
  await assert.rejects(cancelEngine.cancelZeroEffect(cancelledOwner, 'cancel-1'), /material or block receipts/)
  blocked.receipts = {}; cancellation.world.inventory.oak_planks = 1
  await assert.rejects(cancelEngine.cancelZeroEffect(cancelledOwner, 'cancel-1'), /empty agent inventory/)
  delete cancellation.world.inventory.oak_planks
  await cancelEngine.cancelZeroEffect(cancelledOwner, 'cancel-1')
  assert.equal(blocked.status, 'cancelled'); assert.equal(cancelEngine.unfinished(ownerId), undefined)
  assert.deepEqual(blocked.plan, { action: 'gather', item: 'oak_planks', count: 2 }); assert.deepEqual(blocked.receipts, {})
  assert.deepEqual(unlocks, [{ id: blocked.id, locked: false }])
  const retained = JSON.parse(await readFile(join(temporary, 'explicit-cancel', 'personal-agent-tasks.json'), 'utf8')).tasks[0]
  assert.equal(retained.status, 'cancelled'); assert.equal(retained.operationId, 'old-gather-request')
  assert.equal(cancellation.world.withdraws + cancellation.world.deposits + cancellation.world.placements, 0)
  console.log('PASS explicit zero-effect cancellation retains durable task history and confirms unlock; pending effects, material receipts and carried items refuse cancellation')
} finally { await rm(temporary, { recursive: true, force: true }) }
