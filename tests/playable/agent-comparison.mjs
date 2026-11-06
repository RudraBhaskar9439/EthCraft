import assert from 'node:assert/strict'
import { comparisonOwners, comparisonTrials, scoreArch, scoreBench, scoreDelivery, sanitizedUsageReceipt, requireCurrentWorkflow } from '../../scripts/compare_agents.mjs'
import { validateRecoveryTask } from '../../scripts/recover_agent_comparison.mjs'

assert.equal(new Set(comparisonOwners.map(owner => owner.ownerId)).size, 2)
assert.deepEqual(comparisonOwners.map(owner => owner.slotName), ['CityAgent2', 'CityAgent3'])
assert.equal(comparisonTrials.length, 3)
const receipt = sanitizedUsageReceipt({ model: 'glm-4.7', requestId: 'fixture-request', responseId: 'fixture-response', costNanoUsd: 1234,
  usage: { prompt_tokens: 2, completion_tokens: 3, apiKey: 'never-publish-this' }, apiKey: 'never-publish-this',
  pricing: { inputNanoUsd: 900, outputNanoUsd: 3300, source: 'https://router-api.0g.ai/v1/models', apiKey: 'never-publish-this' } })
assert.equal(receipt.usage.prompt_tokens, 2); assert.equal(receipt.costNanoUsd, 1234)
assert.equal(receipt.pricing.source, 'https://router-api.0g.ai/v1/models')
assert(!JSON.stringify(receipt).includes('never-publish-this'))
assert.equal(sanitizedUsageReceipt(undefined), null)
const retainedArch = { id: 'previous-arch', status: 'complete' }
assert.throws(() => requireCurrentWorkflow('new-bench', retainedArch, 'The operation was aborted due to timeout'), /COMPARISON_PLANNING_FAILED:.*timeout/)
assert.deepEqual(retainedArch, { id: 'previous-arch', status: 'complete' })
const currentBench = { id: 'new-bench', status: 'running' }
assert.equal(requireCurrentWorkflow('new-bench', currentBench), currentBench)
const recoveryOwner = comparisonOwners[1], recoveryBench = { operationId: 'original-bench' }
const recoveryWorkflow = { id: recoveryBench.operationId, steps: [{ action: 'build_structure' }] }
const recoveryTask = { slotName: recoveryOwner.slotName, operationId: recoveryBench.operationId + ':step:0', ownerId: recoveryOwner.ownerId, materialCount: 14, status: 'reconciliation_required' }
validateRecoveryTask(recoveryBench, recoveryWorkflow, recoveryTask, recoveryOwner)
assert.throws(() => validateRecoveryTask(recoveryBench, recoveryWorkflow, { ...recoveryTask, ownerId: 'different-owner' }, recoveryOwner))
assert.throws(() => validateRecoveryTask(recoveryBench, { ...recoveryWorkflow, id: 'earlier-arch' }, recoveryTask, recoveryOwner))
assert.throws(() => validateRecoveryTask(recoveryBench, recoveryWorkflow, { ...recoveryTask, status: 'complete' }, recoveryOwner))
const stock = { source: { cobblestone: 64, oak_planks: 128 }, destination: {}, inventory: {} }
assert(Object.values(scoreDelivery(stock, { source: { cobblestone: 58, oak_planks: 128 }, destination: { cobblestone: 6 }, inventory: {} })).every(Boolean))
assert.equal(scoreDelivery(stock, { source: { cobblestone: 58, oak_planks: 128 }, destination: { cobblestone: 5 }, inventory: { cobblestone: 1 } }).inventoryConserved, false)
const arch = Object.fromEntries([0, 1, 2].flatMap(x => [0, 1, 2].map(y => [[x, y, 0].join(','), x === 1 && y < 2 ? 'air' : 'cobblestone'])))
assert(Object.values(scoreArch(arch, 7, 7)).every(Boolean))
assert.equal(scoreArch({ ...arch, '1,0,0': 'cobblestone' }, 8, 8).centralOpeningClear, false)
assert.equal(scoreArch({ ...arch, '0,1,0': 'air' }, 6, 6).sevenExpectedBlocks, false)
const bench = {}
for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 2; z++) bench[[x, y, z].join(',')] = 'air'
for (let x = 0; x < 4; x++) { bench[[x, 1, 0].join(',')] = 'oak_planks'; bench[[x, 2, 1].join(',')] = 'oak_planks' }
for (const x of [0, 3]) { for (const z of [0, 1]) bench[[x, 0, z].join(',')] = 'oak_planks'; bench[[x, 1, 1].join(',')] = 'oak_planks' }
assert(Object.values(scoreBench(bench, 14, 14)).every(Boolean))
assert.equal(scoreBench({ ...bench, '1,1,1': 'oak_planks' }, 15, 15).openBack, false)
assert.equal(scoreBench({ ...bench, '2,2,1': 'air' }, 13, 13).topRail, false)
assert.equal(scoreBench(bench, 15, 14).boundedMaterialUse, false)
console.log('PASS comparison scoring fixtures detect missing blocks, filled openings, material loss and distinct controlled owners; no paid calls or Minecraft execution')
