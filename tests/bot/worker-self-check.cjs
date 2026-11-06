'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { ConstructionWorker, desiredState, structural, itemFor } = require('../../backend/src/bot/construction-worker.cjs')
const { acquireLocalLease, readCheckpoint } = require('../../backend/src/bot/checkpoint-store.cjs')

async function main () {
  const bytes = await fs.readFile(path.join(__dirname, '../../fixtures/blueprints/calculator-v1.json'))
  const blueprint = JSON.parse(bytes)
  const blueprintSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcity-worker-check-'))
  let passed = 0
  const check = label => { passed++; console.log(`PASS ${label}`) }
  const deployment = { serverId: 'self-check', jobId: crypto.randomUUID(), agreementVersion: 1,
    plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintSha256 }

  function fixture () {
    const blocks = Object.fromEntries(blueprint.placements.map(p => [p.position.map((n, i) => n + [-12, 81, -4][i]).join(','), 'minecraft:air']))
    const inventory = {}; const stock = { ...blueprint.material_bill }; const receipts = new Map()
    const state = { revision: 0, lockMode: 'NONE', quarantined: false, pendingOperation: null }
    return { actorId: '00000000-0000-3000-8000-000000000001', apiUrl: 'self-check', blocks, inventory, stock, state, placed: 0,
      observe: async () => ({ blocks: { ...blocks }, inventory: { ...inventory }, state: { ...state }, mode: 'survival', alive: true }),
      openStock: async () => {}, closeStock: async () => {}, stockCount: item => stock[item] || 0,
      referenceFor: () => true, preparePlacement: async () => {},
      envelope: async (action, params) => ({ operationId: crypto.randomUUID(), action, params, expectedRevision: state.revision }),
      command: async command => {
        const { item, count } = command.params
        assert.ok(stock[item] >= count)
        stock[item] -= count; inventory[item] = (inventory[item] || 0) + count
        const reply = { status: 'APPLIED', revision: state.revision }
        receipts.set(command.operationId, reply)
        return reply
      },
      async place (p, command) {
        assert.equal(blocks[p.key], 'minecraft:air')
        assert.ok(inventory[p.item] > 0)
        blocks[p.key] = p.state; inventory[p.item]--; state.revision++; this.placed++
        const reply = { status: 'APPLIED', revision: state.revision }
        receipts.set(command.operationId, reply)
        if (this.loseNextAcknowledgement) { this.loseNextAcknowledgement = false; throw new Error('injected acknowledgement loss') }
        return reply
      },
      replay: async command => ({ ...receipts.get(command.operationId), status: 'REPLAY' })
    }
  }
  const worker = (adapter, name, changes = {}) => new ConstructionWorker({ adapter, blueprint, blueprintSha256, deployment,
    checkpointPath: path.join(directory, name + '.json'), ...changes })

  try {
    assert.equal(structural('minecraft:redstone_wire', { north: 'side', power: 15 }), 'minecraft:redstone_wire')
    assert.equal(desiredState({ block: 'minecraft:lever', properties: { face: 'floor', powered: false } }), 'minecraft:lever[face=floor,facing=north]')
    assert.equal(itemFor('minecraft:redstone_wall_torch'), 'minecraft:redstone_torch')
    check('structural states preserve orientation and remove only dynamic signals')

    assert.throws(() => worker(fixture(), 'wrong-hash', { blueprintSha256: '0'.repeat(64) }), /BLUEPRINT_HASH_MISMATCH/)
    assert.throws(() => worker(fixture(), 'rotation', { orientation: 'rotate90' }), /UNSUPPORTED_ORIENTATION/)
    check('unapproved blueprint and transform fail before actions')

    const full = fixture()
    const partial = await worker(full, 'full').run({ maxPlacements: 3 })
    assert.equal(partial.status, 'checkpointed'); assert.equal(full.placed, 3)
    const finished = await worker(full, 'full').run()
    assert.equal(finished.status, 'built'); assert.equal(finished.readiness, false); assert.equal(full.placed, 144)
    assert.ok(Object.values(full.stock).every(n => n === 0)); assert.ok(Object.values(full.inventory).every(n => n === 0))
    const again = await worker(full, 'full').run()
    assert.equal(again.status, 'built'); assert.equal(full.placed, 144)
    check('144 modeled placements resume from observed state without double consumption or readiness claims')

    const lostAck = fixture(); lostAck.loseNextAcknowledgement = true
    const interrupted = await worker(lostAck, 'ack-loss').run()
    assert.equal(interrupted.status, 'waiting'); assert.equal(lostAck.placed, 1)
    assert.ok((await readCheckpoint(path.join(directory, 'ack-loss.json'))).pending)
    const recovered = await worker(lostAck, 'ack-loss').run()
    assert.equal(recovered.status, 'built'); assert.equal(lostAck.placed, 144)
    check('effect-before-acknowledgement recovery replays receipt instead of placing again')

    const short = fixture(); short.stock['minecraft:stone_bricks'] = 0
    const shortage = await worker(short, 'shortage').run()
    assert.equal(shortage.status, 'waiting'); assert.match(shortage.reason, /MATERIAL_SHORTAGE/); assert.equal(short.placed, 0)
    check('shortage blocks without creating materials')

    const occupied = fixture(); occupied.blocks[Object.keys(occupied.blocks)[0]] = 'minecraft:cobblestone'
    const refused = await worker(occupied, 'occupied').run()
    assert.equal(refused.status, 'waiting'); assert.match(refused.reason, /UNEXPECTED_BLOCK/); assert.equal(occupied.placed, 0)
    check('unexpected occupied target blocks before withdrawal or placement')

    const release = await acquireLocalLease('self-check-exclusive-' + directory)
    try { await assert.rejects(acquireLocalLease('self-check-exclusive-' + directory), error => error.code === 'EADDRINUSE') } finally { await release() }
    const releaseAgain = await acquireLocalLease('self-check-exclusive-' + directory); await releaseAgain()
    check('local worker exclusion releases when the OS listener closes')

    const concurrentAdapter = fixture()
    const originalObserve = concurrentAdapter.observe
    let continueObservation
    let observing
    const observationBlocked = new Promise(resolve => { continueObservation = resolve })
    const observationStarted = new Promise(resolve => { observing = resolve })
    concurrentAdapter.observe = async () => {
      observing()
      await observationBlocked
      return originalObserve()
    }
    const concurrentWorker = worker(concurrentAdapter, 'same-instance')
    const activeRun = concurrentWorker.run({ maxPlacements: 0 })
    await observationStarted
    const duplicateRun = await concurrentWorker.run()
    assert.equal(duplicateRun.reason, 'LOCAL_WORKER_ALREADY_ACTIVE')
    const competingWorker = await worker(fixture(), 'competing-instance').run()
    assert.equal(competingWorker.reason, 'LOCAL_WORKER_ALREADY_ACTIVE')
    continueObservation()
    assert.equal((await activeRun).status, 'checkpointed')
    check('same-instance duplicate run preserves the active job lease')

    const changed = fixture(); changed.inventory['minecraft:redstone'] = 1
    const untracked = await worker(changed, 'untracked').run()
    assert.equal(untracked.status, 'waiting'); assert.equal(untracked.reason, 'UNTRACKED_CARRIED_STOCK')
    check('untracked carried inventory cannot become job stock')

    console.log(JSON.stringify({ status: 'pass', checks: passed, scope: 'scripted domain self-check; no Minecraft, model, tokens, or external-service verification' }))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
