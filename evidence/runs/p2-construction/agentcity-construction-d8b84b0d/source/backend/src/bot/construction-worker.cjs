'use strict'

const crypto = require('node:crypto')
const { readCheckpoint, writeCheckpoint, acquireLocalLease } = require('./checkpoint-store.cjs')

const DYNAMIC = new Set(['lit', 'powered', 'power', 'locked'])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

function structural (material, properties = {}) {
  const entries = Object.entries(properties).filter(([name]) => {
    if (DYNAMIC.has(name)) return false
    return material !== 'minecraft:redstone_wire' || !['north', 'south', 'east', 'west'].includes(name)
  })
  entries.sort(([firstName], [secondName]) => firstName.localeCompare(secondName))
  if (!entries.length) return material
  const fields = entries.map(([name, value]) => `${name}=${value}`)
  return `${material}[${fields.join(',')}]`
}

function desiredState (placement) {
  const properties = { ...placement.properties }
  if (placement.block === 'minecraft:lever' && properties.facing === undefined) properties.facing = 'north'
  return structural(placement.block, properties)
}

function itemFor (block) {
  if (block === 'minecraft:redstone_wire') return 'minecraft:redstone'
  if (block === 'minecraft:redstone_wall_torch') return 'minecraft:redstone_torch'
  return block
}

function countsEqual (firstCounts, secondCounts) {
  const items = new Set([...Object.keys(firstCounts), ...Object.keys(secondCounts)])
  return [...items].every(item => (firstCounts[item] || 0) === (secondCounts[item] || 0))
}

class ConstructionWorker {
  constructor ({ adapter, blueprint, blueprintSha256, deployment, checkpointPath, orientation = 'identity' }) {
    if (orientation !== 'identity') throw new Error('UNSUPPORTED_ORIENTATION')
    if (!/^[a-f0-9]{64}$/.test(blueprintSha256) || blueprintSha256 !== deployment.blueprintSha256) {
      throw new Error('BLUEPRINT_HASH_MISMATCH')
    }
    if (blueprint.id !== 'calculator-v1' || !Array.isArray(blueprint.placements) || blueprint.placements.length !== 144) {
      throw new Error('UNSUPPORTED_BLUEPRINT')
    }
    this.adapter = adapter
    this.file = checkpointPath
    this.running = false
    const origin = deployment.plotMin.map((coordinate, axis) => coordinate + [4, 1, 4][axis])
    const seen = new Set()
    this.placements = blueprint.placements.map(placement => {
      if (!Array.isArray(placement.position) || placement.position.length !== 3 || !placement.position.every(Number.isSafeInteger)) {
        throw new Error('BLUEPRINT_POSITION')
      }
      const position = placement.position.map((coordinate, axis) => coordinate + origin[axis])
      const key = position.join(',')
      const insidePlot = position.every((coordinate, axis) => coordinate >= deployment.plotMin[axis] && coordinate <= deployment.plotMax[axis])
      if (seen.has(key) || !insidePlot) throw new Error('BLUEPRINT_BOUNDS_OR_DUPLICATE')
      seen.add(key)
      return { ...placement, position, key, state: desiredState(placement), item: itemFor(placement.block), stage: placement.position[1] }
    }).sort((first, second) => first.stage - second.stage || first.position[0] - second.position[0] || first.position[2] - second.position[2])
    const materialBill = {}
    for (const placement of this.placements) {
      materialBill[placement.item] = (materialBill[placement.item] || 0) + 1
    }
    if (!countsEqual(materialBill, blueprint.material_bill)) throw new Error('MATERIAL_BILL_MISMATCH')
    this.binding = {
      serverId: deployment.serverId,
      jobId: deployment.jobId,
      agreementVersion: deployment.agreementVersion,
      actorId: adapter.actorId,
      blueprintSha256,
      semanticSha256: crypto.createHash('sha256').update(JSON.stringify(blueprint)).digest('hex'),
      origin,
      constructionAccessSha256: deployment.constructionAccessSha256 || null
    }
    this.key = JSON.stringify(this.binding)
    this.leaseBinding = `${adapter.apiUrl || 'local'}:${deployment.serverId}:${deployment.jobId}`
  }

  async save () {
    await writeCheckpoint(this.file, this.checkpoint)
  }

  async open () {
    if (this.release) throw new Error('WORKER_ALREADY_OPEN')
    this.release = await acquireLocalLease(this.leaseBinding)
    this.checkpoint = await readCheckpoint(this.file)
    if (this.checkpoint && JSON.stringify(this.checkpoint.binding) !== this.key) {
      throw new Error('CHECKPOINT_BINDING_MISMATCH')
    }
    if (!this.checkpoint) {
      this.checkpoint = {
        schema: 'agentcity.construction-checkpoint.v1',
        binding: this.binding,
        completed: [],
        receipts: [],
        stages: [],
        pending: null,
        inventory: null
      }
      await this.save()
    }
    if (this.checkpoint.schema !== 'agentcity.construction-checkpoint.v1' ||
        !Array.isArray(this.checkpoint.receipts) || !Array.isArray(this.checkpoint.completed) ||
        !Array.isArray(this.checkpoint.stages)) {
      throw new Error('CHECKPOINT_FORMAT')
    }
  }

  async close () {
    if (!this.release) return
    const release = this.release
    this.release = null
    await release()
  }

  safeObservation (observation) {
    if (observation.mode !== 'survival' || observation.alive === false) throw new Error('SURVIVAL_ACTOR_REQUIRED')
    if (observation.state.quarantined) throw new Error('RECONCILIATION_REQUIRED')
    if (observation.state.lockMode !== 'NONE') throw new Error('PLOT_LOCKED')
    for (const placement of this.placements) {
      const actual = observation.blocks[placement.key]
      if (actual === undefined) throw new Error('WORLD_OBSERVATION_UNAVAILABLE')
      if (!AIR.has(actual) && actual !== placement.state) throw new Error(`UNEXPECTED_BLOCK:${placement.key}`)
    }
  }

  async observe () {
    const observation = await this.adapter.observe(this.placements)
    this.safeObservation(observation)
    return observation
  }

  async finishPending (reply, observation) {
    const pending = this.checkpoint.pending
    const expectedInventory = { ...pending.beforeInventory }
    const isWithdrawal = pending.command.action === 'WITHDRAW'
    const item = isWithdrawal ? pending.command.params.item : pending.item
    const count = isWithdrawal ? pending.command.params.count : 1
    expectedInventory[item] = (expectedInventory[item] || 0) + (isWithdrawal ? count : -count)
    const applied = reply.status === 'APPLIED' || reply.status === 'REPLAY'
    if (applied) {
      if (!countsEqual(observation.inventory, expectedInventory)) throw new Error('INVENTORY_EFFECT_MISMATCH')
      if (pending.target && observation.blocks[pending.target] !== pending.state) {
        throw new Error('PLACEMENT_EFFECT_MISMATCH')
      }
      this.checkpoint.receipts.push({
        operationId: pending.command.operationId,
        action: pending.command.action,
        revision: reply.revision,
        item,
        count,
        target: pending.target || null
      })
    } else if (reply.status === 'REFUSED' && reply.code === 'RECORDED_NOT_APPLIED') {
      const inventoryUnchanged = countsEqual(observation.inventory, pending.beforeInventory)
      const blockUnchanged = !pending.target || observation.blocks[pending.target] === pending.beforeBlock
      if (!inventoryUnchanged || !blockUnchanged) throw new Error('NOT_APPLIED_EFFECT_MISMATCH')
    } else {
      throw new Error(`OPERATION_WAIT:${reply.code || reply.status}`)
    }
    this.checkpoint.pending = null
    this.checkpoint.inventory = observation.inventory
    await this.save()
    return applied
  }

  async recover () {
    if (!this.checkpoint.pending) return
    const reply = await this.adapter.replay(this.checkpoint.pending.command)
    await this.finishPending(reply, await this.observe())
  }

  async perform (action, params, placement, before) {
    const command = await this.adapter.envelope(action, params)
    this.checkpoint.pending = {
      command,
      beforeInventory: before.inventory,
      item: placement?.item || null,
      target: placement?.key || null,
      beforeBlock: placement ? before.blocks[placement.key] : null,
      state: placement?.state || null
    }
    await this.save()
    const reply = placement ? await this.adapter.place(placement, command) : await this.adapter.command(command)
    const observed = await this.observe()
    if (!await this.finishPending(reply, observed)) throw new Error('NATIVE_OPERATION_NOT_APPLIED')
    return observed
  }

  async run ({ maxPlacements = 144 } = {}) {
    if (this.running) {
      return { status: 'waiting', reason: 'LOCAL_WORKER_ALREADY_ACTIVE', completed: 0, placedThisRun: 0, readiness: false }
    }
    this.running = true
    let placed = 0
    try {
      if (!Number.isInteger(maxPlacements) || maxPlacements < 0 || maxPlacements > 144) throw new Error('PLACEMENT_BUDGET')
      await this.open()
      await this.recover()
      let observation = await this.observe()
      if (observation.state.pendingOperation) throw new Error('OTHER_OPERATION_PENDING')
      if (this.checkpoint.inventory && !countsEqual(this.checkpoint.inventory, observation.inventory)) {
        throw new Error('CARRIED_STOCK_CHANGED')
      }
      if (!this.checkpoint.inventory && Object.values(observation.inventory).some(count => count !== 0)) {
        throw new Error('UNTRACKED_CARRIED_STOCK')
      }
      this.checkpoint.inventory = observation.inventory
      const needed = {}
      for (const placement of this.placements) {
        if (observation.blocks[placement.key] !== placement.state) {
          needed[placement.item] = (needed[placement.item] || 0) + 1
        }
      }
      for (const [item, total] of Object.entries(needed)) {
        let remaining = total - (observation.inventory[item] || 0)
        while (remaining > 0) {
          const count = Math.min(64, remaining)
          await this.adapter.openStock()
          try {
            if (this.adapter.stockCount(item) < count) throw new Error(`MATERIAL_SHORTAGE:${item}`)
            observation = await this.perform('WITHDRAW', { item, count }, null, observation)
          } finally {
            await this.adapter.closeStock()
          }
          remaining -= count
        }
      }
      while (true) {
        observation = await this.observe()
        const missing = this.placements.filter(placement => observation.blocks[placement.key] !== placement.state)
        this.checkpoint.completed = this.placements
          .filter(placement => observation.blocks[placement.key] === placement.state)
          .map(placement => placement.key)
        if (!missing.length) {
          this.checkpoint.status = 'built'
          await this.save()
          return { status: 'built', completed: 144, placedThisRun: placed, readiness: false, stages: this.checkpoint.stages }
        }
        if (placed >= maxPlacements) {
          this.checkpoint.status = 'checkpointed'
          await this.save()
          return { status: 'checkpointed', completed: 144 - missing.length, placedThisRun: placed, readiness: false }
        }
        const candidate = missing.find(placement => this.adapter.referenceFor(placement))
        if (!candidate) throw new Error('PLACEMENT_SUPPORT_UNAVAILABLE')
        if (!(observation.inventory[candidate.item] > 0)) throw new Error(`MATERIAL_SHORTAGE:${candidate.item}`)
        await this.adapter.preparePlacement(candidate)
        const before = await this.observe()
        if (before.blocks[candidate.key] !== observation.blocks[candidate.key] || !countsEqual(before.inventory, observation.inventory)) {
          throw new Error('OBSERVATION_CHANGED_BEFORE_PLACE')
        }
        const [x, y, z] = candidate.position
        const params = { x, y, z, state: candidate.state }
        observation = await this.perform('PLACE', params, candidate, before)
        placed++
        const stages = [...new Set(this.placements.map(placement => placement.stage))]
        for (const stage of stages) {
          if (this.checkpoint.stages.some(receipt => receipt.stage === stage)) continue
          const stagePlacements = this.placements.filter(placement => placement.stage === stage)
          const complete = stagePlacements.every(placement => observation.blocks[placement.key] === placement.state)
          if (complete) {
            this.checkpoint.stages.push({ stage, revision: observation.state.revision, placements: stagePlacements.length })
          }
        }
        this.checkpoint.inventory = observation.inventory
        await this.save()
      }
    } catch (error) {
      const reason = error.code === 'EADDRINUSE' ? 'LOCAL_WORKER_ALREADY_ACTIVE' : error.message
      return { status: 'waiting', reason, completed: this.checkpoint?.completed?.length || 0, placedThisRun: placed, readiness: false }
    } finally {
      try {
        await this.close()
      } finally {
        this.running = false
      }
    }
  }
}

module.exports = { ConstructionWorker, structural, desiredState, itemFor, countsEqual }
