import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroGRouter, loadZeroGProvider, requestZeroGPlan } from '../../backend/src/inference/zero-g.mjs'
import { initializeZeroGBudget } from '../../backend/src/inference/zero-g-budget.mjs'

const directory = await mkdtemp(join(tmpdir(), 'agentcity-zero-g-'))
const credentialsFile = join(directory, '.local/inference/zero-g.env')
const budget = { file: join(directory, 'usage.json'), authorizationId: 'five-dollar-fixture', limitUsd: '5' }
const messages = [{ role: 'system', content: 'Only propose safe actions.' }, { role: 'user', content: 'Inspect my supplies.' }]
const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }
const plan = { action: 'inspect' }
const originalFetch = globalThis.fetch
let paidCalls = 0, priceChanged = false, mode = 'valid'
globalThis.fetch = async (url, options) => {
  assert.equal(options.redirect, 'error')
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'glm-4.7', pricing_usd: { prompt: priceChanged ? '0.1' : '0.0000009', completion: '0.0000033' },
    context_length: 204800, max_completion_tokens: 131072, supported_parameters: ['tools', 'tool_choice'] }] })
  assert.equal(url, 'https://router-api.0g.ai/v1/chat/completions')
  assert.equal(options.headers.Authorization, 'Bearer sk-fixture-only')
  const request = JSON.parse(options.body)
  assert.equal(request.max_tokens, 4096)
  assert.deepEqual(request.tools[0].function.parameters, schema)
  assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'return_plan' } })
  assert.equal(request.parallel_tool_calls, undefined)
  paidCalls++
  if (mode === 'timeout') throw Error('fixture timeout')
  if (mode === 'unsupported') return new Response('{}', { status: 400 })
  return Response.json({ id: 'fixture-' + paidCalls, model: request.model, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    choices: [{ finish_reason: mode === 'truncated' ? 'length' : 'tool_calls', message: { tool_calls: [{ type: 'function',
      function: { name: 'return_plan', arguments: mode === 'malformed' ? '{' : JSON.stringify(plan) } }] } }] })
}
const state = async () => JSON.parse(await readFile(budget.file, 'utf8'))

try {
  await mkdir(join(directory, '.local/inference'), { recursive: true })
  await writeFile(credentialsFile, 'ZERO_G_API_KEY=sk-fixture-only\n', { mode: 0o600 })
  await assert.rejects(loadZeroGProvider(directory), /PAID_CALLS_NOT_ENABLED/)
  await assert.rejects(requestZeroGPlan({ ...zeroGRouter, apiKey: 'sk-fixture-only' }, messages, schema), /INVALID_ZERO_G_CONFIGURATION/)
  assert.equal(paidCalls, 0)
  await writeFile(credentialsFile, 'ZERO_G_API_KEY=sk-fixture-only\nZERO_G_LIVE_ACCESS=1\n', { mode: 0o600 })
  await assert.rejects(loadZeroGProvider(directory, { budgetId: budget.authorizationId, budgetUsd: budget.limitUsd, budgetFile: budget.file }), /STATE_INVALID_OR_MISSING/)
  await initializeZeroGBudget(budget)
  const provider = await loadZeroGProvider(directory, { budgetId: budget.authorizationId, budgetUsd: budget.limitUsd, budgetFile: budget.file })
  assert.deepEqual(await requestZeroGPlan(provider, messages, schema), plan)
  assert.equal((await state()).completedRequests, 1)
  const capped = await loadZeroGProvider(directory, { budgetId: budget.authorizationId, budgetUsd: budget.limitUsd,
    budgetFile: budget.file, maxTokens: 1536, timeoutMs: 60000 })
  assert.equal(capped.maxTokens, 1536)
  assert.equal(capped.timeoutMs, 60000)
  await assert.rejects(requestZeroGPlan(capped, messages, schema, { maxTokens: 1537 }), /INVALID_ZERO_G_REQUEST/)
  await assert.rejects(requestZeroGPlan(capped, messages, schema, { timeoutMs: 60001 }), /INVALID_ZERO_G_REQUEST/)
  console.log('PASS key alone cannot spend; 0G uses the fixed Router, forced tool schema and explicit initialized budget')

  const before = paidCalls
  await assert.rejects(requestZeroGPlan({ ...provider, baseUrl: 'https://example.org' }, messages, schema), /INVALID_ZERO_G_CONFIGURATION/)
  await assert.rejects(requestZeroGPlan(provider, [{ role: 'user', content: 'x'.repeat(32000) }], schema), /INPUT_TOO_LARGE/)
  priceChanged = true
  await assert.rejects(requestZeroGPlan(provider, messages, schema), /PRICE_OR_CAPABILITIES_CHANGED/)
  assert.equal(paidCalls, before)
  priceChanged = false
  for (const invalid of ['truncated', 'malformed']) {
    mode = invalid
    await assert.rejects(requestZeroGPlan(provider, messages, schema), /INVALID_ZERO_G_PLAN/)
  }
  assert.equal((await state()).completedRequests, 3)
  console.log('PASS changed prices, excess input and unsafe endpoints fail before spending; incomplete/malformed plans never execute')

  for (const failure of ['timeout', 'unsupported']) {
    mode = failure
    await assert.rejects(requestZeroGPlan(provider, messages, schema), failure === 'timeout' ? /fixture timeout/ : /ZERO_G_HTTP_400/)
  }
  assert.equal(Object.keys((await state()).pending).length, 2)
  assert.equal(paidCalls, 5)
  console.log('PASS timeout and unsupported tool errors retain durable reservations without silently retrying or switching providers; no paid calls')
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
}
