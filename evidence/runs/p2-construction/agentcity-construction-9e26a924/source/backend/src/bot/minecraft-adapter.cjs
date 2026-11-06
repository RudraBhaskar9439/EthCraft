'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { structural } = require('./construction-worker.cjs')

const FACING = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
const YAW = { south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 }
const SUPPORTS = new Set(['stone', 'stone_bricks', 'glass', 'redstone_lamp', 'redstone_torch', 'redstone_wall_torch'])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function bounded (promise, milliseconds, reason) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

class MinecraftAdapter {
  constructor ({ bot, deployment, apiUrl, apiToken, session, dependencyRoot, accessBounds, constructionAccess, accessPlan }) {
    const actorId = bot.player?.uuid || bot.entity?.uuid || bot._client?.uuid
    if (!apiUrl || !apiToken || !session || !/^[a-f0-9-]{36}$/i.test(actorId || '') || !accessBounds) throw new Error('MISSING_RUNTIME_BINDING')
    const url = new URL(apiUrl)
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('LOCAL_CONTROL_REQUIRED')
    this.bot = bot
    this.deployment = deployment
    this.apiUrl = apiUrl.replace(/\/$/, '')
    this.apiToken = apiToken
    this.session = session
    this.actorId = actorId
    this.origin = deployment.plotMin.map((coordinate, axis) => coordinate + [4, 1, 4][axis])
    this.stances = accessPlan || constructionAccess?.stances || {}
    this.accessStairs = constructionAccess?.stairs || null
    this.accessBounds = accessBounds
    const modules = dependencyRoot || path.resolve(__dirname, '../../../tests/compatibility/node_modules')
    const { pathfinder, Movements, goals } = require(path.join(modules, 'mineflayer-pathfinder'))
    this.Vec3 = require(path.join(modules, 'vec3')).Vec3
    this.goals = goals
    if (!bot.pathfinder) bot.loadPlugin(pathfinder)
    const moves = new Movements(bot)
    moves.canDig = false
    moves.allow1by1towers = false
    moves.allowParkour = false
    // The pinned library counts down to the support block, not its top; 2 enables this declared half-step descent.
    moves.maxDropDown = 2
    moves.scafoldingBlocks = []
    moves.exclusionAreasBreak.push(() => 100)
    moves.exclusionAreasPlace.push(() => 100)
    moves.exclusionAreasStep.push(block => {
      const outsideAccess = block.position.toArray().some((coordinate, axis) =>
        coordinate < accessBounds.min[axis] || coordinate > accessBounds.max[axis])
      const relativeX = block.position.x - this.origin[0]
      const relativeZ = block.position.z - this.origin[2]
      // calculator-v1 uses the fixed outer tracks, never its internal support maze.
      const insidePinnedCalculatorFootprint = relativeX >= 0 && relativeX <= 13 && relativeZ >= -1 && relativeZ <= 2
      return outsideAccess || insidePinnedCalculatorFootprint ? 100 : 0
    })
    bot.pathfinder.setMovements(moves)
    this.lastCommand = 0
  }

  block (position) {
    return this.bot.blockAt(new this.Vec3(...position))
  }

  inventory () {
    const counts = {}
    const playerInventory = this.bot.currentWindow || this.bot.inventory
    for (const item of playerInventory.items()) {
      const name = `minecraft:${item.name}`
      counts[name] = (counts[name] || 0) + item.count
    }
    return counts
  }

  async request (route, body) {
    if (body) {
      await delay(Math.max(0, 650 - (performance.now() - this.lastCommand)))
      this.lastCommand = performance.now()
    }
    const response = await fetch(this.apiUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'X-AgentCity-Session': this.session,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    })
    const result = await response.json()
    if (!response.ok) return { status: 'REFUSED', code: result.code || `HTTP_${response.status}` }
    return result
  }

  async state () {
    const reply = await this.request('/status')
    if (!reply.state) throw new Error(`STATE_UNAVAILABLE:${reply.code || 'UNKNOWN'}`)
    return reply.state
  }

  async observe (placements) {
    const state = await this.state()
    const blocks = {}
    for (const placement of placements) {
      const block = this.block(placement.position)
      if (block) blocks[placement.key] = structural(`minecraft:${block.name}`, block.getProperties())
    }
    return { state, blocks, inventory: this.inventory(), mode: this.bot.game.gameMode?.toLowerCase(), alive: this.bot.health > 0 && !!this.bot.entity }
  }

  async envelope (action, params) {
    const current = await this.state()
    return {
      operationId: crypto.randomUUID(),
      serverId: this.deployment.serverId,
      jobId: this.deployment.jobId,
      agreementVersion: this.deployment.agreementVersion,
      actorId: this.actorId,
      expectedRevision: current.revision,
      authorizationReference: this.deployment.authorizationReference,
      expiresAtMs: Date.now() + 8000,
      action,
      params
    }
  }

  async replay (command) {
    let result
    const until = performance.now() + 16000
    do {
      result = await this.request('/command', command)
      if (result.status !== 'PREPARED' && !(result.status === 'REFUSED' && result.code === 'BUSY')) {
        await bounded(this.bot.waitForTicks(3), 1500, 'CLIENT_UPDATE_TIMEOUT')
        return result
      }
      await delay(350)
    } while (performance.now() < until)
    return { status: 'RECONCILIATION_REQUIRED', code: 'PENDING_OPERATION_TIMEOUT' }
  }

  async waitInventory (item, count) {
    const until = performance.now() + 3000
    do {
      if ((this.inventory()[item] || 0) === count) return
      await delay(50)
    } while (performance.now() < until)
    throw new Error('INVENTORY_UPDATE_TIMEOUT')
  }

  async command (command) {
    const item = command.params.item
    const before = this.inventory()[item] || 0
    const result = await this.request('/command', command)
    if (result.status === 'APPLIED') await this.waitInventory(item, before + command.params.count)
    return result
  }

  async go (position) {
    const insideAccess = position.every((coordinate, axis) => Number.isFinite(coordinate) &&
      coordinate >= this.accessBounds.min[axis] && coordinate <= this.accessBounds.max[axis] + 0.99)
    if (!insideAccess) throw new Error('NAVIGATION_OUT_OF_BOUNDS')
    const goalCoordinates = position.map(coordinate => Math.floor(coordinate))
    const goal = new this.goals.GoalBlock(...goalCoordinates)
    const snapshotPlayer = () => {
      const entity = this.bot.entity
      return {
        position: entity?.position ? [entity.position.x, entity.position.y, entity.position.z] : null,
        onGround: entity?.onGround ?? null
      }
    }
    const diagnostics = { goal: goalCoordinates, start: snapshotPlayer(), end: null, pathUpdates: [] }
    this.lastNavigation = diagnostics
    const pathUpdated = result => {
      diagnostics.pathUpdates.push({
        status: typeof result.status === 'string' ? result.status : null,
        pathLength: Array.isArray(result.path) ? result.path.length : null,
        visitedNodes: typeof result.visitedNodes === 'number' ? result.visitedNodes : null,
        elapsedMs: typeof result.time === 'number' ? result.time : null
      })
      if (diagnostics.pathUpdates.length > 4) diagnostics.pathUpdates.shift()
    }
    this.bot.on('path_update', pathUpdated)
    let navigation
    try {
      navigation = this.bot.pathfinder.goto(goal)
      await bounded(navigation, 18000, 'NAVIGATION_TIMEOUT')
      const actual = this.bot.entity?.position
      const observed = actual ? [actual.x, actual.y, actual.z] : []
      const reached = observed.length === 3 && observed.every((coordinate, axis) => Math.floor(coordinate) === goalCoordinates[axis])
      if (!reached) throw new Error('GOAL_NOT_REACHED')
    } catch (error) {
      this.bot.pathfinder.setGoal(null)
      this.bot.clearControlStates()
      if (navigation) await navigation.catch(() => {})
      diagnostics.end = snapshotPlayer()
      diagnostics.clientBlocks = {}
      const feetY = Math.floor(diagnostics.start.position?.[1] ?? goalCoordinates[1])
      const minX = Math.floor(this.accessBounds.min[0])
      const minZ = Math.floor(this.accessBounds.min[2])
      const maxX = Math.min(Math.floor(this.accessBounds.max[0]), minX + 31)
      const maxZ = Math.min(Math.floor(this.accessBounds.max[2]), minZ + 15)
      for (const y of [feetY - 1, feetY, feetY + 1]) {
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = [x, y, z].join(',')
            let state = null
            try {
              const block = this.block([x, y, z])
              if (block) {
                const fields = Object.entries(block.getProperties()).sort(([first], [second]) => first.localeCompare(second))
                const properties = fields.map(([name, value]) => `${name}=${value}`).join(',')
                state = `minecraft:${block.name}` + (properties ? `[${properties}]` : '')
              }
            } catch {
              // Missing client state stays null and must not hide the original navigation failure.
            }
            diagnostics.clientBlocks[key] = state
          }
        }
      }
      const actual = this.bot.entity?.position
      const observed = actual ? [actual.x, actual.y, actual.z].map(coordinate => Number(coordinate.toFixed(3))) : null
      throw new Error(`NAVIGATION_BLOCKED:${error.message};goal=${JSON.stringify(goalCoordinates)};observed=${JSON.stringify(observed)}`)
    } finally {
      diagnostics.end = snapshotPlayer()
      this.bot.removeListener('path_update', pathUpdated)
    }
  }

  async openStock () {
    const chest = this.deployment.chest
    await this.goViaAccessRoute([chest[0], chest[1], chest[2] - 1])
    const block = this.block(chest)
    if (!block || block.name !== 'chest') throw new Error('JOB_STOCK_UNAVAILABLE')
    this.container = await bounded(this.bot.openContainer(block), 5000, 'JOB_STOCK_OPEN_TIMEOUT')
  }

  stockCount (item) {
    if (!this.container) throw new Error('JOB_STOCK_NOT_OPEN')
    const stockSlots = this.container.slots.slice(0, this.container.inventoryStart)
    return stockSlots.filter(value => value && `minecraft:${value.name}` === item)
      .reduce((sum, value) => sum + value.count, 0)
  }

  async closeStock () {
    if (!this.container) return
    this.container.close()
    this.container = null
    await bounded(this.bot.waitForTicks(2), 1500, 'STOCK_CLOSE_TIMEOUT')
  }

  async goViaAccessRoute (position) {
    const stairs = this.accessStairs
    if (!stairs?.start_relative || !Array.isArray(stairs.landings_relative)) {
      throw new Error('CONSTRUCTION_ROUTE_UNAVAILABLE')
    }
    const waypoints = [stairs.start_relative, ...stairs.landings_relative]
    const currentHeight = this.bot.entity.position.y - this.origin[1]
    const targetHeight = position[1] - this.origin[1]
    const currentLevel = waypoints.find(point => Math.abs(point[1] - currentHeight) < 0.05)
    const targetLevel = waypoints.find(point => Math.abs(point[1] - targetHeight) < 0.05)
    if (!currentLevel) throw new Error('ACCESS_START_OFF_LEVEL')
    if (!targetLevel) throw new Error('ACCESS_TARGET_OFF_LEVEL')

    if (currentLevel[1] !== targetLevel[1]) {
      await this.go(currentLevel.map((coordinate, axis) => coordinate + this.origin[axis]))
      const ascending = targetLevel[1] > currentLevel[1]
      const route = waypoints.filter(point => ascending
        ? point[1] > currentLevel[1] && point[1] <= targetLevel[1]
        : point[1] < currentLevel[1] && point[1] >= targetLevel[1])
      route.sort((first, second) => ascending ? first[1] - second[1] : second[1] - first[1])
      for (const waypoint of route) {
        await this.go(waypoint.map((coordinate, axis) => coordinate + this.origin[axis]))
      }
    }
    await this.go(position)
  }

  referenceFor (placement) {
    const properties = placement.properties || {}
    let faces
    if (placement.block === 'minecraft:redstone_wall_torch' || (placement.block === 'minecraft:lever' && properties.face === 'wall')) {
      faces = [FACING[properties.facing]]
    } else if (['minecraft:redstone_wire', 'minecraft:redstone_torch', 'minecraft:repeater', 'minecraft:lever'].includes(placement.block)) {
      faces = [[0, 1, 0]]
    } else {
      faces = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
    }
    for (const face of faces) {
      if (!face) continue
      const position = placement.position.map((coordinate, axis) => coordinate - face[axis])
      const block = this.block(position)
      if (block && SUPPORTS.has(block.name)) return { block, face: new this.Vec3(...face) }
    }
    return null
  }

  async preparePlacement (placement) {
    const relative = placement.position.map((coordinate, axis) => coordinate - this.origin[axis]).join(',')
    const stance = this.stances[relative]
    if (!stance) throw new Error(`ACCESS_STANCE_MISSING:${relative}`)
    await this.goViaAccessRoute(stance.map((coordinate, axis) => coordinate + this.origin[axis]))
    const held = this.bot.inventory.items().find(item => `minecraft:${item.name}` === placement.item)
    if (!held) throw new Error(`MATERIAL_SHORTAGE:${placement.item}`)
    await bounded(this.bot.equip(held, 'hand'), 3000, 'EQUIP_TIMEOUT')
    if (!this.referenceFor(placement)) throw new Error('PLACEMENT_SUPPORT_UNAVAILABLE')
  }

  async place (placement, command) {
    const reference = this.referenceFor(placement)
    if (!reference) throw new Error('PLACEMENT_SUPPORT_UNAVAILABLE')
    const hit = reference.block.position.offset(0.5 + reference.face.x / 2, 0.5 + reference.face.y / 2, 0.5 + reference.face.z / 2)
    if (this.bot.entity.position.offset(0, 1.62, 0).distanceTo(hit) > 4.5) throw new Error(`PLACEMENT_OUT_OF_REACH:${placement.key}`)
    const itemCount = this.inventory()[placement.item] || 0
    const prepared = await this.request('/command', command)
    if (prepared.status !== 'PREPARED') return prepared
    const options = { swingArm: 'right' }
    if (placement.block === 'minecraft:repeater') {
      await this.bot.look(YAW[placement.properties.facing] + Math.PI, 0, true)
      options.forceLook = 'ignore'
    } else if (placement.block === 'minecraft:lever' && placement.properties.face !== 'wall') {
      await this.bot.look(YAW[placement.properties.facing || 'north'], 0, true)
      options.forceLook = 'ignore'
    }
    try {
      // The pinned Mineflayer helper preserves cardinal yaw for native oriented placement.
      await bounded(this.bot._placeBlockWithOptions(reference.block, reference.face, options), 6500, 'NATIVE_PLACE_TIMEOUT')
    } catch (error) {
      // The durable receipt and actual observations decide whether a failed acknowledgement applied.
      const recovered = await this.replay(command)
      if (recovered.status === 'REPLAY' || recovered.status === 'APPLIED') await this.waitInventory(placement.item, itemCount - 1)
      return recovered
    }
    const result = await this.replay(command)
    if (result.status === 'REPLAY' || result.status === 'APPLIED') await this.waitInventory(placement.item, itemCount - 1)
    return result
  }
}

module.exports = { MinecraftAdapter, bounded }
