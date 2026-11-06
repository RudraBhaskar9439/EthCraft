'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { MinecraftAdapter } = require('../../backend/src/bot/minecraft-adapter.cjs')

const dependencyRoot = path.resolve(__dirname, '../compatibility/node_modules')
const windows = require(path.join(dependencyRoot, 'prismarine-windows'))('1.21.11')

function checkActiveWindowInventory () {
  const window = windows.createWindow(7, 'minecraft:generic_9x3', 'job stock')
  window.slots[0] = { name: 'redstone', count: 40 }
  window.slots[window.inventoryStart] = { name: 'redstone', count: 19 }

  const adapter = Object.create(MinecraftAdapter.prototype)
  adapter.bot = {
    inventory: { items: () => [{ name: 'redstone', count: 2 }] },
    currentWindow: window
  }

  assert.deepEqual(adapter.inventory(), { 'minecraft:redstone': 19 })
  adapter.bot.currentWindow = null
  assert.deepEqual(adapter.inventory(), { 'minecraft:redstone': 2 })
  console.log('PASS active chest window supplies current player inventory and excludes container stock')
}

async function checkNavigationRecovery () {
  const adapter = Object.create(MinecraftAdapter.prototype)
  adapter.accessBounds = { min: [-10, 0, -10], max: [10, 20, 10] }
  adapter.goals = {
    GoalBlock: class GoalBlock {
      constructor (x, y, z) {
        this.x = x
        this.y = y
        this.z = z
      }
    }
  }

  let attempts = 0
  let cancellations = 0
  let controlsCleared = 0
  adapter.bot = Object.assign(new EventEmitter(), {
    entity: { position: { x: 0.5, y: 1, z: 0.5 }, onGround: true },
    pathfinder: {
      async goto (goal) {
        attempts++
        if (attempts === 1) {
          for (let update = 0; update < 6; update++) {
            adapter.bot.emit('path_update', { status: 'partial', path: [goal], visitedNodes: update, time: update + 0.5, context: { mustNotBeRetained: true } })
          }
          throw new Error('injected blocked path')
        }
        adapter.bot.entity.position = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }
      },
      setGoal (goal) {
        assert.equal(goal, null)
        cancellations++
      },
      stop () {
        throw new Error('Deferred stop must not poison the next navigation goal')
      }
    },
    clearControlStates () {
      controlsCleared++
    }
  })
  adapter.block = () => ({ name: 'stone', getProperties: () => ({}) })

  await assert.rejects(adapter.go([4, 1, 6]), /NAVIGATION_BLOCKED:injected blocked path/)
  const diagnostics = adapter.lastNavigation
  assert.deepEqual(diagnostics.goal, [4, 1, 6])
  assert.deepEqual(diagnostics.start, { position: [0.5, 1, 0.5], onGround: true })
  assert.deepEqual(diagnostics.end, diagnostics.start)
  assert.equal(diagnostics.pathUpdates.length, 4)
  assert.equal(diagnostics.pathUpdates[0].visitedNodes, 2)
  assert.deepEqual(Object.keys(diagnostics.pathUpdates[0]), ['status', 'pathLength', 'visitedNodes', 'elapsedMs'])
  assert.equal(Object.keys(diagnostics.clientBlocks).length, 21 * 16 * 3)
  assert.ok(Object.keys(diagnostics.clientBlocks).length <= 32 * 16 * 3)
  assert.equal(adapter.bot.listenerCount('path_update'), 0)
  await adapter.go([1, 1, 0])
  assert.equal(attempts, 2)
  assert.equal(cancellations, 1)
  assert.equal(controlsCleared, 1)
  assert.equal(adapter.bot.listenerCount('path_update'), 0)
  console.log('PASS failed navigation cancels immediately without stopping the next goal')

  adapter.bot.pathfinder.goto = async () => {}
  await assert.rejects(adapter.go([7, 1, 8]), error => {
    assert.match(error.message, /GOAL_NOT_REACHED/)
    assert.match(error.message, /goal=\[7,1,8\]/)
    assert.match(error.message, /observed=\[1.5,1,0.5\]/)
    return true
  })
  assert.equal(cancellations, 2)
  assert.equal(controlsCleared, 2)

  adapter.bot.entity.position = { x: 7.25, y: 1, z: 8.25 }
  await adapter.go([7, 1, 8])
  assert.equal(cancellations, 2)
  console.log('PASS falsely resolved navigation is refused until the actual player reaches the requested block')

  adapter.bot.entity.position = { x: 7.5, y: 1.42159999847412, z: 8.5 }
  adapter.bot.entity.onGround = false
  let legsStarted = 0
  let settlementTicks = 0
  adapter.bot.pathfinder.goto = async goal => {
    legsStarted++
    if (legsStarted === 2) {
      assert.equal(adapter.bot.entity.onGround, true, 'The next leg cannot start while airborne')
      assert.equal(adapter.bot.entity.position.y, 1)
      adapter.bot.entity.position = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }
    }
  }
  adapter.bot.waitForTicks = async () => {
    settlementTicks++
    adapter.bot.entity.position.y = settlementTicks === 1 ? 1.26636799395752 : 1
    adapter.bot.entity.onGround = settlementTicks > 1
  }
  await adapter.go([7, 1, 8])
  await adapter.go([9, 1, 8])
  assert.equal(settlementTicks, 2)
  assert.equal(legsStarted, 2)
  assert.equal(adapter.bot.listenerCount('path_update'), 0)
  console.log('PASS floor-matching airborne descent waits for grounding at goal height before the next leg')
}

async function checkDeclaredAccessRoutes () {
  const adapter = Object.create(MinecraftAdapter.prototype)
  adapter.origin = [0, 0, 0]
  adapter.accessStairs = {
    start_relative: [7, 0, 7],
    landings_relative: [[13, 3, 7], [19, 6, 7], [25, 9, 7]]
  }
  adapter.bot = { entity: { position: { x: 0.5, y: 0, z: -2.5 } } }
  const visited = []
  adapter.go = async position => { visited.push(position) }
  adapter.goOnDeck = adapter.go

  await adapter.goViaAccessRoute([2.5, 0, 4.5])
  assert.deepEqual(visited, [[2.5, 0, 4.5]])

  visited.length = 0
  await adapter.goViaAccessRoute([2.5, 6, 4.5])
  assert.deepEqual(visited, [[7, 0, 7], [13, 3, 7], [19, 6, 7], [2.5, 6, 4.5]])

  visited.length = 0
  adapter.bot.entity.position.y = 9
  await adapter.goViaAccessRoute([2.5, 0, 4.5])
  assert.deepEqual(visited, [[25, 9, 7], [19, 6, 7], [13, 3, 7], [7, 0, 7], [2.5, 0, 4.5]])

  visited.length = 0
  adapter.bot.entity.position.y = 1.5
  await assert.rejects(adapter.goViaAccessRoute([2.5, 3, 4.5]), /ACCESS_START_OFF_LEVEL/)
  assert.deepEqual(visited, [])
  console.log('PASS declared access routes preserve same-level travel, ordered ascent/descent, and off-level refusal')
}

async function checkDeclaredLaneCrossings () {
  const adapter = Object.create(MinecraftAdapter.prototype)
  adapter.origin = [0, 0, 0]
  adapter.crossingXCoordinates = [-2, 15]
  adapter.laneZCoordinates = [-3, 4]
  adapter.bot = { entity: { position: { x: 1.5, y: 3, z: -2.5 } } }
  const visited = []
  adapter.go = async position => {
    visited.push(position)
    adapter.bot.entity.position = { x: Math.floor(position[0]) + 0.5, y: position[1], z: Math.floor(position[2]) + 0.5 }
  }

  await adapter.goOnDeck([3.5, 3, 4.5])
  assert.deepEqual(visited, [[-2, 3, -3], [-2, 3, 4], [3.5, 3, 4.5]])

  visited.length = 0
  adapter.bot.entity.position = { x: 12.5, y: 6, z: 4.5 }
  await adapter.goOnDeck([11.5, 6, -2.5])
  assert.deepEqual(visited, [[15, 6, 4], [15, 6, -3], [11.5, 6, -2.5]])

  visited.length = 0
  await adapter.goOnDeck([9.5, 6, -2.5])
  assert.deepEqual(visited, [[9.5, 6, -2.5]])
  console.log('PASS opposite lanes use the nearer declared west/east bridge while same-side travel remains direct')
}

function checkPinnedHalfStepDescent () {
  const registry = require(path.join(dependencyRoot, 'prismarine-registry'))('1.21.11')
  const Block = require(path.join(dependencyRoot, 'prismarine-block'))(registry)
  const { Vec3 } = require(path.join(dependencyRoot, 'vec3'))
  const AStar = require(path.join(dependencyRoot, 'mineflayer-pathfinder/lib/astar'))
  const Move = require(path.join(dependencyRoot, 'mineflayer-pathfinder/lib/move'))
  const { GoalBlock } = require(path.join(dependencyRoot, 'mineflayer-pathfinder/lib/goals'))
  const access = require('../../fixtures/construction/access-v1.json')
  const bounds = access.navigation_bounds_relative
  const states = new Map(access.positions.map(position => [position.join(','), 'minecraft:glass']))
  for (const position of access.bottom_slabs) {
    states.set(position.join(','), 'minecraft:stone_slab[type=bottom,waterlogged=false]')
  }

  let movements
  const bot = {
    registry,
    game: { minY: -64 },
    player: { uuid: '00000000-0000-3000-8000-000000000001' },
    inventory: { items: () => [] },
    pathfinder: { setMovements: configured => { movements = configured } },
    blockAt (position) {
      const cell = position.floored()
      const insideFloor = cell.x >= bounds.min[0] && cell.x <= bounds.max[0] &&
        cell.z >= bounds.min[2] && cell.z <= bounds.max[2]
      const fallback = cell.y === -1 && insideFloor ? 'minecraft:stone' : 'minecraft:air'
      const block = Block.fromString(states.get(cell.toArray().join(',')) || fallback, 0)
      block.position = cell
      return block
    }
  }
  new MinecraftAdapter({
    bot,
    deployment: { plotMin: [-4, -1, -4] },
    apiUrl: 'http://127.0.0.1:25578',
    apiToken: 'fixture-only',
    session: 'fixture-only',
    dependencyRoot,
    accessBounds: bounds,
    constructionAccess: access
  })
  assert.equal(movements.maxDropDown, 2)
  assert.equal(movements.canDig, false)
  assert.equal(movements.allow1by1towers, false)

  const points = [access.stairs.start_relative, ...access.stairs.landings_relative].reverse()
  const standingHeight = node => {
    let support = bot.blockAt(node)
    if (!support.shapes.length) support = bot.blockAt(node.offset(0, -1, 0))
    assert.ok(support.shapes.length, 'Every declared route node needs observed support')
    return support.position.y + Math.max(...support.shapes.map(shape => shape[4]))
  }
  for (let segment = 0; segment < points.length - 1; segment++) {
    const start = new Move(...points[segment], 0, 0)
    const goal = new GoalBlock(...points[segment + 1])
    const search = new AStar(start, movements, goal, 5000, 40, -1)
    let result
    do { result = search.compute() } while (result.status === 'partial')
    assert.equal(result.status, 'success', 'Each declared reverse staircase segment must be reachable')
    let previousHeight = standingHeight(start)
    for (const node of result.path) {
      const height = standingHeight(node)
      assert.ok(previousHeight - height <= 1, 'These declared reverse paths must not introduce a physical drop over one block')
      previousHeight = height
    }
  }
  console.log('PASS pinned planner reaches all three declared reverse segments without a physical drop over one block on those paths')
}

async function checkOrientedPlacementFlush () {
  const { Vec3 } = require(path.join(dependencyRoot, 'vec3'))
  const placements = [
    { block: 'minecraft:repeater', item: 'minecraft:repeater', properties: { facing: 'west' }, expectedYaw: Math.PI * 1.5 },
    { block: 'minecraft:lever', item: 'minecraft:lever', properties: { face: 'floor' }, expectedYaw: Math.PI * 2 }
  ]
  for (const placement of placements) {
    const adapter = Object.create(MinecraftAdapter.prototype)
    const calls = []
    let itemCount = 1
    let localYaw = 0
    let sentYaw = null
    adapter.inventory = () => ({ [placement.item]: itemCount })
    adapter.referenceFor = () => ({ block: { position: new Vec3(0, 0, 0) }, face: new Vec3(0, 1, 0) })
    adapter.request = async () => {
      calls.push('prepare')
      return { status: 'PREPARED' }
    }
    adapter.replay = async () => {
      calls.push('receipt')
      return { status: 'REPLAY' }
    }
    adapter.bot = {
      entity: { position: new Vec3(0.5, 1, 0.5) },
      async look (yaw, pitch, force) {
        assert.equal(force, true)
        assert.equal(yaw, placement.expectedYaw, 'Native placement must use the heading opposite the required block facing')
        calls.push('look')
        localYaw = yaw
      },
      async waitForTicks (ticks) {
        assert.equal(ticks, 1)
        calls.push('physics-tick')
        await Promise.resolve()
        sentYaw = localYaw
      },
      async _placeBlockWithOptions (reference, face, options) {
        assert.equal(options.forceLook, 'ignore')
        assert.equal(sentYaw, localYaw, 'Native placement must follow the orientation tick flush')
        calls.push('place')
        itemCount--
      }
    }
    const result = await adapter.place(placement, {})
    assert.equal(result.status, 'REPLAY')
    assert.deepEqual(calls, ['prepare', 'look', 'physics-tick', 'place', 'receipt'])
  }
  console.log('PASS repeater and default-north floor lever use opposite headings and flush the orientation tick before placement')
}

async function checkThinReferences () {
  const { Vec3 } = require(path.join(dependencyRoot, 'vec3'))
  for (const referenceName of ['repeater', 'redstone_wire']) {
    const adapter = Object.create(MinecraftAdapter.prototype)
    adapter.Vec3 = Vec3
    const reference = { name: referenceName, position: new Vec3(0, 0, 0) }
    adapter.block = position => position.join(',') === '0,0,0' ? reference : null
    const placement = { block: 'minecraft:stone_bricks', item: 'minecraft:stone_bricks', properties: {}, position: [0, 1, 0] }
    assert.equal(adapter.referenceFor(placement).block, reference)

    const calls = []
    let carried = 1
    let sneaking = false
    let sneakSent = false
    adapter.inventory = () => ({ 'minecraft:stone_bricks': carried })
    adapter.request = async () => ({ status: 'PREPARED' })
    adapter.replay = async () => ({ status: 'REPLAY' })
    adapter.bot = {
      entity: { position: new Vec3(0.5, 1, 0.5) },
      getControlState: () => sneaking,
      setControlState (control, value) {
        assert.equal(control, 'sneak')
        sneaking = value
        calls.push(value ? 'sneak-on' : 'sneak-off')
      },
      async waitForTicks (ticks) {
        assert.equal(ticks, 1)
        sneakSent = sneaking
        calls.push('physics-tick')
      },
      async _placeBlockWithOptions (block) {
        assert.equal(block, reference)
        assert.equal(sneaking, true)
        assert.equal(sneakSent, true)
        carried--
        calls.push('place')
      }
    }
    assert.equal((await adapter.place(placement, {})).status, 'REPLAY')
    assert.deepEqual(calls, ['sneak-on', 'physics-tick', 'place', 'sneak-off'])
    assert.equal(sneaking, false)

    const solid = { name: 'stone_bricks', position: new Vec3(-1, 1, 0) }
    adapter.block = position => {
      if (position.join(',') === '0,0,0') return reference
      return position.join(',') === '-1,1,0' ? solid : null
    }
    assert.equal(adapter.referenceFor(placement).block, solid, 'Existing solid references retain priority')
  }
  console.log('PASS repeater/wire references require a sneak tick and restore controls; solid references retain priority')
}

async function main () {
  checkActiveWindowInventory()
  await checkNavigationRecovery()
  await checkDeclaredAccessRoutes()
  await checkDeclaredLaneCrossings()
  checkPinnedHalfStepDescent()
  await checkOrientedPlacementFlush()
  await checkThinReferences()
  console.log(JSON.stringify({
    status: 'pass',
    checks: 9,
    scope: 'Focused adapter regressions using the pinned window implementation and scripted navigation; no live Minecraft verification.'
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
