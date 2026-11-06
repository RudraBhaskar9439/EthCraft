import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directAnthropic, loadAgentModelProvider, requestAnthropicPlan } from '../../backend/src/inference/anthropic.mjs'
import { createIntentPlanner, validateIntent } from '../../backend/src/playable/intent-planner.mjs'
import { PersonalAgents } from '../../backend/src/playable/agents.mjs'
import { initializeAnthropicBudget } from '../../backend/src/inference/anthropic-budget.mjs'

const directory = await mkdtemp(join(tmpdir(), 'agentcity-anthropic-'))
const originalFetch = globalThis.fetch
const messages = [{ role: 'system', content: 'Propose a plan; never execute it.' }, { role: 'user', content: 'Inspect my supplies.' }]
const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }
let calls = 0, status = 200, stopReason = 'tool_use', oversized = false, textReply = null
let answer = { kind: 'plan', message: 'Inspect the actual supplies.', steps: [{ action: 'inspect' }] }
globalThis.fetch = async (url, options) => {
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers.Authorization, 'Bearer sk-ant-fixture-only')
  assert.equal(options.headers['anthropic-version'], '2026-10-21')
  if (url.startsWith('https://api.anthropic.com/v1/models/')) {
    const legacy = url.endsWith('/claude-sonnet-4-6'), unavailable = url.endsWith('/claude-fixture-no-mode')
    return new Response(JSON.stringify({ capabilities: { thinking: { types: {
      disabled: { supported: legacy }, between_tools: { supported: !legacy && !unavailable }
    } } } }))
  }
  if (url === 'https://api.anthropic.com/v1/messages/count_tokens') return new Response(JSON.stringify({ input_tokens: 100 }))
  calls++
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers.Authorization, 'Bearer sk-ant-fixture-only')
  assert.equal(options.headers['anthropic-version'], '2026-10-21')
  const body = JSON.parse(options.body)
  assert.equal(body.model, directAnthropic.model)
  assert.equal(body.tool_choice.type, 'auto')
  assert.match(body.system, /calling return_plan exactly once/)
  assert.equal(body.tool_choice.disable_parallel_tool_use, true)
  assert.equal(body.tools[0].input_schema.type, 'object')
  assert.equal(body.thinking.type, 'between_tools')
  assert(body.max_tokens > 0 && body.max_tokens <= 4096)
  assert(body.messages.every(value => ['user', 'assistant'].includes(value.role)))
  assert.equal(typeof body.system, 'string')
  assert(!options.body.includes('sk-ant-'))
  return new Response(oversized ? 'x'.repeat(65537) : JSON.stringify({
    id: 'fixture-response', model: body.model, stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: textReply === null ? [{ type: 'tool_use', id: 'fixture-tool', name: 'return_plan', input: answer }] : [{ type: 'text', text: textReply }]
  }), { status })
}

try {
  assert.equal((await loadAgentModelProvider(directory)).kind, 'ollama')
  await assert.rejects(loadAgentModelProvider(directory, { provider: 'openrouter' }), /UNSUPPORTED_AGENT_MODEL_PROVIDER/)
  const credentials = join(directory, '.local/inference/anthropic.env')
  await mkdir(join(directory, '.local/inference'), { recursive: true })
  await writeFile(credentials, 'ANTHROPIC_API_KEY=sk-ant-fixture-only\n', { mode: 0o600 })
  await assert.rejects(loadAgentModelProvider(directory, { provider: 'anthropic' }), /ANTHROPIC_PAID_CALLS_NOT_ENABLED/)
  await assert.rejects(requestAnthropicPlan({ ...directAnthropic, apiKey: 'sk-ant-fixture-only' }, messages, schema), /INVALID_ANTHROPIC_CONFIGURATION/)
  assert.equal(calls, 0)
  console.log('PASS saving a key does not enable paid requests; existing Ollama selection is preserved')

  await writeFile(credentials, 'ANTHROPIC_API_KEY=sk-ant-fixture-only\nANTHROPIC_LIVE_ACCESS=1\n', { mode: 0o600 })
  const budget = { file: join(directory, 'budget.json'), authorizationId: 'fixture-approval', limitUsd: '1.00' }
  await initializeAnthropicBudget(budget)
  const budgetSettings = { budgetFile: budget.file, budgetId: budget.authorizationId, budgetUsd: budget.limitUsd }
  const provider = await loadAgentModelProvider(directory, { provider: 'anthropic', ...budgetSettings })
  const capped = await loadAgentModelProvider(directory, { provider: 'anthropic', ...budgetSettings, maxTokens: 1536, timeoutMs: 60000 })
  assert.equal(capped.maxTokens, 1536)
  assert.equal(capped.timeoutMs, 60000)
  await assert.rejects(requestAnthropicPlan(capped, messages, schema, { maxTokens: 1537 }), /INVALID_ANTHROPIC_REQUEST/)
  await assert.rejects(requestAnthropicPlan(capped, messages, schema, { timeoutMs: 60001 }), /INVALID_ANTHROPIC_REQUEST/)
  assert.equal(provider.thinkingMode, 'between_tools')
  assert.equal((await loadAgentModelProvider(directory, { provider: 'anthropic', model: 'claude-sonnet-4-6', ...budgetSettings })).thinkingMode, 'disabled')
  await assert.rejects(loadAgentModelProvider(directory, { provider: 'anthropic', model: 'claude-fixture-no-mode', ...budgetSettings }), /ANTHROPIC_BUDGET_MODEL_UNSUPPORTED/)
  const planner = await createIntentPlanner({ runtimeDirectory: join(directory, 'planner'), provider })
  assert.deepEqual(validateIntent(await planner.requestModel(messages)), answer)
  assert(!(await readFile(join(directory, 'planner/agent-conversations.json'), 'utf8')).includes('sk-ant-'))
  console.log('PASS native Anthropic structured transport reaches the personal planner without persisting credentials')

  stopReason = 'end_turn'; textReply = JSON.stringify(answer)
  assert.deepEqual(validateIntent(await planner.requestModel(messages)), answer)
  textReply = 'not valid JSON'
  await assert.rejects(planner.requestModel(messages), /INVALID_ANTHROPIC_PLAN/)
  stopReason = 'tool_use'; textReply = null
  console.log('PASS completed native JSON text is validated like tool input; malformed or incomplete output is refused')

  answer = { action: 'wait' }
  const legacy = new PersonalAgents({ rootDirectory: directory, runtimeDirectory: join(directory, 'legacy'), modelProvider: provider })
  assert.equal((await legacy.plan('wait')).action, 'wait')
  console.log('PASS legacy personal-agent requests use the same native Anthropic adapter')

  const before = calls
  await assert.rejects(requestAnthropicPlan({ ...provider, baseUrl: 'https://openrouter.ai/api/v1' }, messages, schema), /INVALID_ANTHROPIC_CONFIGURATION/)
  assert.equal(calls, before)
  answer = { kind: 'plan', message: 'Unsupported action', steps: [{ action: 'eval', code: 'arbitrary code' }] }
  await assert.rejects(planner.interpret({ ownerId: 'fixture-owner', text: 'Propose a task.' }), /INVALID_INTENT_STEP/)
  status = 401
  await assert.rejects(planner.requestModel(messages), /ANTHROPIC_HTTP_401/)
  status = 200; stopReason = 'max_tokens'
  await assert.rejects(planner.requestModel(messages), /INVALID_ANTHROPIC_PLAN/)
  stopReason = 'tool_use'; oversized = true
  await assert.rejects(planner.requestModel(messages), /ANTHROPIC_RESPONSE_TOO_LARGE/)
  console.log('PASS foreign hosts, invalid actions, authentication errors, truncated plans and oversized responses fail closed')
  console.log('PASS fixtures only: no real Anthropic generation, Minecraft execution or spending')
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
}
