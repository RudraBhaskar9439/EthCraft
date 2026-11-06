// Actual Ollama blueprint/planning checks; no game clients or material effects.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createIntentPlanner } from '../../backend/src/playable/intent-planner.mjs'
import { localOllama } from '../../backend/src/inference/providers.mjs'
import { compileTaskPlan } from '../../backend/src/playable/task-tools.mjs'

const runId = randomUUID(), directory = resolve('evidence/runs/playable-autonomy-language', runId)
await mkdir(directory, { recursive: true })
const provider = { ...localOllama, model: process.env.AGENTCITY_AGENT_MODEL || 'qwen3:4b' }
const planner = await createIntentPlanner({ runtimeDirectory: resolve('.local/autonomy-language', runId), provider })
const report = { status: 'fail', scope: 'Actual local Ollama diverse structure design and material preparation language only; no native construction, gathering, crafting or human proof', model: provider.model, checks: [], independentHumansVerified: 0, publicTransactions: 0 }
const region = { slotName: 'CityAgent2', min: { x: -47, y: 64, z: 2 }, max: { x: -36, y: 71, z: 13 }, origin: [-45, 64, 4], sourceChest: [-47, 64, 2], destinationChest: [-47, 64, 4] }
const samples = [
  ['arch', 'Build a three-block-wide oak arch, two pillars and a top beam, three blocks high.', { registeredRegion: region, inventory: [], materialsAndWorld: { recordedStructures: [], sourceObservation: { items: { oak_planks: 32 }, historical: true } } }, intent => {
    assert.equal(intent.kind, 'plan'); assert.equal(intent.steps.length, 1)
    const blueprint = intent.steps[0]
    assert.equal(blueprint.action, 'build_structure'); assert.equal(blueprint.material, 'oak_planks')
    const compiled = compileTaskPlan(blueprint, region)
    assert.equal(compiled.placements.length, 7)
    const offsets = compiled.placements.map(block => block.position), minimum = [0, 1, 2].map(axis => Math.min(...offsets.map(p => p[axis])))
    const normalized = offsets.map(p => p.map((value, axis) => value - minimum[axis]))
    const width = Math.max(...normalized.map(p => p[0])) + 1, depth = Math.max(...normalized.map(p => p[2])) + 1
    assert(width === 3 && depth === 1 || width === 1 && depth === 3)
    const cells = normalized.map(p => [width === 3 ? p[0] : p[2], p[1]]).map(p => p.join(',')).sort()
    assert.deepEqual(cells, ['0,0', '0,1', '0,2', '1,2', '2,0', '2,1', '2,2'])
    assert(compiled.placements.every(block => block.material === 'oak_planks'))
  }],
  ['house', 'Build a 4 by 4 wooden house, 4 blocks high.', { registeredRegion: region, inventory: [] }, intent => {
    assert.equal(intent.kind, 'plan'); assert.equal(intent.steps.length, 1)
    const design = intent.steps[0]; assert.equal(design.action, 'build_structure'); assert.equal(design.structure, 'house'); assert.equal(design.width, 4); assert.equal(design.depth, 4); assert.equal(design.height, 4); assert.equal(design.material, 'oak_planks')
  }],
  ['craft', 'Gather two oak planks from permitted blocks in my plot, craft four sticks, and put all four sticks in my destination chest.', { registeredRegion: region, inventory: [], materialsAndWorld: { lastInspection: { source: { oak_planks: 0, stick: 0 }, resources: [{ item: 'oak_planks', offset: [5, 0, 4] }, { item: 'oak_planks', offset: [6, 0, 4] }] } } }, intent => {
    assert.equal(intent.kind, 'plan')
    assert.deepEqual(intent.steps.map(({ action, item, count }) => ({ action, item, count })), [{ action: 'gather', item: 'oak_planks', count: 2 }, { action: 'craft', item: 'stick', count: 4 }, { action: 'deliver', item: 'stick', count: 4 }])
  }]
]
try {
  for (const [ownerId, request, context, check] of samples) {
    const item = { request, status: 'fail' }; report.checks.push(item)
    try { item.intent = await planner.interpret({ ownerId, text: request, context }); check(item.intent); item.status = 'pass' }
    catch (error) { item.failure = error.message; if (error.proposal) item.proposal = error.proposal }
    console.log(JSON.stringify(item))
  }
  if (report.checks.every(check => check.status === 'pass')) report.status = 'pass'
} finally { await planner.close(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(directory) }
if (report.status !== 'pass') process.exitCode = 1
