// Actual local Ollama language checks only. No game clients or physical effects.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localOllama } from '../../backend/src/inference/providers.mjs'
import { createIntentPlanner } from '../../backend/src/playable/intent-planner.mjs'
const id = randomUUID(), folder = resolve('evidence/runs/playable-language', id)
await mkdir(folder, { recursive: true })
const provider = { ...localOllama, model: process.env.AGENTCITY_AGENT_MODEL || localOllama.model }
const planner = await createIntentPlanner({ runtimeDirectory: resolve('.local/intent-samples', id), provider })
const report = { status: 'fail', model: provider.model, scope: 'Actual Ollama language samples only; no Minecraft clients, inventory effects or independent-human proof', samples: [] }
const samples = [
  ['compound', 'make me a small wooden shelter, put four cobble in destination and sell four more', { inventory: [] }, intent => {
    assert.equal(intent.kind, 'plan'); assert.deepEqual(intent.steps, [
      { action: 'build_shelter', width: 4, depth: 4, material: 'oak_planks' }, { action: 'deliver', item: 'cobblestone', count: 4 }, { action: 'collect', item: 'cobblestone', count: 4 }, { action: 'sell', item: 'cobblestone', count: 4 }
    ])
  }],
  ['progress', 'what are you doing?', { latestTask: { action: 'build_shelter', status: 'running', completed: 16, total: 54 } }, intent => assert.equal(intent.kind, 'progress')],
  ['stop', 'stop that', { latestTask: { action: 'build_shelter', status: 'running' } }, intent => assert.equal(intent.kind, 'stop')],
  ['ambiguous', 'deliver some stuff', {}, intent => assert.equal(intent.kind, 'clarify')],
  ['reference', 'use stone instead', { latestTask: { action: 'build_shelter', status: 'running', material: 'oak_planks' } }, intent => assert.equal(intent.kind, 'clarify')]
  ,['ambiguous', 'put a couple of cobble in my destination then sell four more', { inventory: [] }, intent => {
    assert.equal(intent.kind, 'plan'); assert.deepEqual(intent.steps, [{ action: 'deliver', item: 'cobblestone', count: 2 }, { action: 'collect', item: 'cobblestone', count: 4 }, { action: 'sell', item: 'cobblestone', count: 4 }])
  }]
]
try {
  for (const [ownerId, text, context, check] of samples) {
    const sample = { request: text, status: 'fail' }; report.samples.push(sample)
    try { sample.intent = await planner.interpret({ ownerId, text, context }); check(sample.intent); sample.status = 'pass' }
    catch (error) { sample.failure = error.message; if (error.proposal) sample.proposal = error.proposal }
    console.log(JSON.stringify(sample))
  }
  if (process.env.AGENTCITY_TEST_MARKET === '1') {
    const market = await createIntentPlanner({ runtimeDirectory: resolve('.local/intent-samples', id, 'market'), provider, marketEnabled: true })
    const sample = { request: 'sell four cobble for CITY then swap two CITY to GEM', status: 'fail', scope: 'Language-only quote proposals; no provider wallet, token transfer or swap execution' }
    report.samples.push(sample)
    try {
      sample.intent = await market.interpret({ ownerId: 'market-language', text: sample.request, context: { inventory: [{ name: 'cobblestone', count: 4 }], market: { marketAvailable: true, supportedAssets: ['CITY', 'GEM'], prices: { cobblestone: '1 CITY' } } } })
      assert.equal(sample.intent.kind, 'plan')
      assert.deepEqual(sample.intent.steps, [{ action: 'market', item: 'cobblestone', count: 4 }, { action: 'swap', amountIn: '2', tokenIn: 'CITY', tokenOut: 'GEM' }])
      sample.status = 'pass'
    } catch (error) { sample.failure = error.message; if (error.proposal) sample.proposal = error.proposal }
    console.log(JSON.stringify(sample))
    const wallet = { request: 'how much CITY do I have?', status: 'fail', scope: 'Language-only read-only wallet intent; no actual balance invented or queried by this sample' }
    report.samples.push(wallet)
    try {
      wallet.intent = await market.interpret({ ownerId: 'wallet-language', text: wallet.request, context: { market: { marketAvailable: true, supportedAssets: ['CITY', 'GEM'] } } })
      assert.equal(wallet.intent.kind, 'plan'); assert.deepEqual(wallet.intent.steps, [{ action: 'wallet' }]); wallet.status = 'pass'
    } catch (error) { wallet.failure = error.message; if (error.proposal) wallet.proposal = error.proposal }
    finally { await market.close() }
    console.log(JSON.stringify(wallet))
  }
  if (report.samples.every(sample => sample.status === 'pass')) report.status = 'pass'
} finally { await planner.close(); await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(folder) }
if (report.status !== 'pass') process.exitCode = 1
