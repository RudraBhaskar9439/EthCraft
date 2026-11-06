import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroGModel, zeroGEconomyModel, initializeZeroGBudget, validateZeroGBudget, reserveZeroGRequest, recordZeroGUsage } from '../../backend/src/inference/zero-g-budget.mjs'

const directory = await mkdtemp(join(tmpdir(), 'agentcity-zero-g-budget-'))
const budget = { file: join(directory, 'usage.json'), authorizationId: 'five-dollar-fixture', limitUsd: '0.2' }
const provider = { model: zeroGModel.model, budget }
const pricing = { ...zeroGModel, source: 'https://router-api.0g.ai/v1/models', observedAt: new Date().toISOString() }
const request = { model: provider.model, max_tokens: 4096, messages: [{ role: 'user', content: 'Fixture only' }] }
const state = async () => JSON.parse(await readFile(budget.file, 'utf8'))

try {
  await assert.rejects(validateZeroGBudget(budget), /STATE_INVALID_OR_MISSING/)
  await assert.rejects(initializeZeroGBudget({ ...budget, limitUsd: '5.01' }), /EXCEEDS_AUTHORIZATION/)
  await initializeZeroGBudget(budget)
  await assert.rejects(validateZeroGBudget({ ...budget, authorizationId: 'new-authorization' }), /STATE_INVALID_OR_MISSING/)
  await assert.rejects(initializeZeroGBudget({ ...budget, limitUsd: '5' }), /STATE_INVALID_OR_MISSING/)
  console.log('PASS 0G ledger requires initialization and binds the exact approval and limit; it cannot silently reset or exceed $5')

  const outcomes = await Promise.allSettled([reserveZeroGRequest(provider, request, pricing), reserveZeroGRequest(provider, request, pricing)])
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  assert.match(outcomes.find(value => value.status === 'rejected').reason.message, /budget exhausted/)
  const id = outcomes.find(value => value.status === 'fulfilled').value
  assert.equal((await state()).pending[id].ceilingNanoUsd, 197836800)
  const receipt = { id: 'fixture-response', model: provider.model, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
  await recordZeroGUsage(provider, id, receipt, 'fixture-request', 25)
  assert.equal((await state()).spentNanoUsd, 123000)
  assert.equal((await state()).lastReceipt.pricing.source, pricing.source)
  assert.equal(Object.keys((await state()).pending).length, 0)
  await assert.rejects(recordZeroGUsage(provider, id, receipt, null, 25), /REQUEST_NOT_PENDING/)
  console.log('PASS concurrent calls reserve the full context ceiling; actual usage reconciles once with price and request proof')

  const unknown = await reserveZeroGRequest(provider, request, pricing)
  await initializeZeroGBudget(budget)
  await assert.rejects(reserveZeroGRequest(provider, request, pricing), /budget exhausted/)
  await assert.rejects(recordZeroGUsage(provider, unknown, { ...receipt, model: 'another-model' }, null, 10), /reconciliation/)
  await assert.rejects(reserveZeroGRequest(provider, request, pricing), /reconciliation/)
  assert((await state()).pending[unknown])
  console.log('PASS restart retains possibly charged requests and mismatched usage blocks further calls')
  const shared={...budget,file:join(directory,'shared-models.json'),limitUsd:'0.5'}
  await initializeZeroGBudget(shared,'0.1')
  const oldProvider={...provider,budget:shared},oldPending=await reserveZeroGRequest(oldProvider,request,pricing)
  const economy={...oldProvider,model:zeroGEconomyModel.model},economyPricing={...zeroGEconomyModel,source:pricing.source,observedAt:new Date().toISOString()}
  const cheap=await reserveZeroGRequest(economy,{...request,model:economy.model,max_tokens:256},economyPricing)
  await recordZeroGUsage(economy,cheap,{...receipt,model:economy.model},'fixture-economy',10)
  const dual=JSON.parse(await readFile(shared.file,'utf8'))
  assert(dual.pending[oldPending]);assert.equal(dual.spentNanoUsd,100010570);assert.equal(dual.limitNanoUsd,500000000)
  assert.equal(dual.lastReceipt.conservativeCostEstimate,true)
  await initializeZeroGBudget(shared);assert.equal(JSON.parse(await readFile(shared.file,'utf8')).spentNanoUsd,dual.spentNanoUsd)
  console.log('PASS economy and advanced models share a finite ledger without resetting original spending or unknown requests')

  const corrupt = { ...budget, file: join(directory, 'corrupt.json') }
  await writeFile(corrupt.file, 'null\n')
  await assert.rejects(initializeZeroGBudget(corrupt), /STATE_INVALID_OR_MISSING/)
  assert.equal(await readFile(corrupt.file, 'utf8'), 'null\n')
  console.log('PASS corrupt budget state remains preserved for review; no paid calls')
} finally { await rm(directory, { recursive: true, force: true }) }
