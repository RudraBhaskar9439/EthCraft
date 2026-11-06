import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeAnthropicBudget, validateAnthropicBudget, reserveAnthropicRequest, recordAnthropicUsage, usdToNano } from '../../backend/src/inference/anthropic-budget.mjs'

const directory = await mkdtemp(join(tmpdir(), 'agentcity-api-budget-'))
const budget = { file: join(directory, 'usage.json'), authorizationId: 'approved-test', limitUsd: '0.01' }
const provider = { model: 'claude-sonnet-5-5', apiKey: 'sk-ant-budget-fixture', budget }
const originalFetch = globalThis.fetch
const body = { model: provider.model, max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'Test proposal only.' }] }
const state = async () => JSON.parse(await readFile(budget.file, 'utf8'))
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.anthropic.com/v1/messages/count_tokens')
  assert.equal(options.redirect, 'error')
  assert.equal(JSON.parse(options.body).max_tokens, undefined)
  return new Response(JSON.stringify({ input_tokens: 100 }))
}
try {
  assert.equal(usdToNano('0.010586'), 10586000)
  await assert.rejects(validateAnthropicBudget(budget, provider.model), /STATE_INVALID_OR_MISSING/)
  await initializeAnthropicBudget(budget, '0.001')
  await validateAnthropicBudget(budget, provider.model)
  await assert.rejects(validateAnthropicBudget({ ...budget, authorizationId: 'another-approval' }, provider.model), /STATE_INVALID_OR_MISSING/)
  await assert.rejects(validateAnthropicBudget({ ...budget, limitUsd: '10' }, provider.model), /STATE_INVALID_OR_MISSING/)
  console.log('PASS budget binds the approved identity and exact decimal limit; missing state cannot silently reset spending')

  const requests = await Promise.allSettled([reserveAnthropicRequest(provider, body), reserveAnthropicRequest(provider, body)])
  assert.equal(requests.filter(value => value.status === 'fulfilled').length, 1)
  assert.match(requests.find(value => value.status === 'rejected').reason.message, /budget exhausted/i)
  const id = requests.find(value => value.status === 'fulfilled').value
  assert.equal(Object.keys((await state()).pending).length, 1)
  console.log('PASS concurrent agents cannot reserve more than the shared total allowance')

  const receipt = { id: 'fixture-response', model: provider.model, usage: { input_tokens: 100, output_tokens: 10 } }
  await recordAnthropicUsage(provider, id, receipt, 'fixture-request')
  assert.equal((await state()).spentNanoUsd, 1300000)
  assert.equal(Object.keys((await state()).pending).length, 0)
  await assert.rejects(recordAnthropicUsage(provider, id, receipt, 'fixture-request'), /REQUEST_NOT_PENDING/)
  assert.equal((await state()).spentNanoUsd, 1300000)
  console.log('PASS actual token usage releases unused reservation; duplicate receipts cannot charge the ledger twice')

  const unresolved = await reserveAnthropicRequest(provider, body)
  await initializeAnthropicBudget(budget)
  await assert.rejects(reserveAnthropicRequest({ ...provider, budget: { ...budget } }, body), /budget exhausted/i)
  assert((await state()).pending[unresolved])
  await recordAnthropicUsage(provider, unresolved, { ...receipt, model: 'unexpected-model' }, 'uncertain-request').then(() => assert.fail('Uncertain usage accepted'), error => assert.match(error.message, /reconciliation/))
  await assert.rejects(reserveAnthropicRequest(provider, body), /reconciliation/)
  assert((await state()).pending[unresolved])
  console.log('PASS restart preserves uncertain reservations and mismatched provider usage pauses further generation')

  const corrupt = { ...budget, file: join(directory, 'corrupt.json') }
  await writeFile(corrupt.file, 'null\n')
  await assert.rejects(initializeAnthropicBudget(corrupt), /STATE_INVALID_OR_MISSING/)
  assert.equal(await readFile(corrupt.file, 'utf8'), 'null\n')
  console.log('PASS corrupt budget state is preserved for review rather than replaced with a fresh allowance; no paid requests')
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
}
