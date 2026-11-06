import { resolve, dirname } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import checkpoints from '../bot/checkpoint-store.cjs'

const { readCheckpoint, writeCheckpoint, acquireLocalLease } = checkpoints
const queues = new Map()
const count = value => Number.isSafeInteger(value) && value >= 0
export const zeroGModel = Object.freeze({ model: 'glm-4.7', inputNanoUsd: 900, outputNanoUsd: 3300, contextTokens: 204800 })
const validPricing = value => value?.model === zeroGModel.model && value.inputNanoUsd === zeroGModel.inputNanoUsd &&
  value.outputNanoUsd === zeroGModel.outputNanoUsd && value.contextTokens === zeroGModel.contextTokens &&
  value.source === 'https://router-api.0g.ai/v1/models' && Number.isFinite(Date.parse(value.observedAt))

function usdToNano(value) {
  const text = String(value)
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw Error('INVALID_ZERO_G_BUDGET')
  const [whole, fraction = ''] = text.split('.')
  const result = Number(BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')))
  if (!count(result)) throw Error('INVALID_ZERO_G_BUDGET')
  return result
}

function terms(budget) {
  if (!budget || typeof budget.file !== 'string' || !budget.file ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(budget.authorizationId || '')) throw Error('ZERO_G_BUDGET_REQUIRED')
  const limitNanoUsd = usdToNano(budget.limitUsd)
  if (!limitNanoUsd || limitNanoUsd > 5000000000) throw Error('ZERO_G_BUDGET_EXCEEDS_AUTHORIZATION')
  return { ...budget, file: resolve(budget.file), limitNanoUsd }
}

function validate(state, budget) {
  if (!state || state.version !== 1 || state.authorizationId !== budget.authorizationId || state.limitNanoUsd !== budget.limitNanoUsd ||
      !count(state.spentNanoUsd) || !count(state.completedRequests) || !state.pending || Array.isArray(state.pending) ||
      typeof state.pending !== 'object' || Object.values(state.pending).some(value =>
        value.model !== zeroGModel.model || !validPricing(value.pricing) || !count(value.ceilingNanoUsd) ||
        value.inputBound !== zeroGModel.contextTokens || !count(value.maxTokens) || !value.maxTokens || value.maxTokens > 4096 ||
        value.ceilingNanoUsd !== zeroGModel.contextTokens * zeroGModel.inputNanoUsd + value.maxTokens * zeroGModel.outputNanoUsd)) {
    throw Error('ZERO_G_BUDGET_STATE_INVALID_OR_MISSING')
  }
  const committed = state.spentNanoUsd + Object.values(state.pending).reduce((sum, value) => sum + value.ceilingNanoUsd, 0)
  if (!count(committed) || committed > budget.limitNanoUsd) throw Error('ZERO_G_BUDGET_STATE_INVALID_OR_MISSING')
  return committed
}

async function mutate(configuration, change, persist = true) {
  const budget = terms(configuration)
  // shortcut: this durable lease fences one host; use a shared ledger before multi-host inference.
  const work = (queues.get(budget.file) || Promise.resolve()).then(async () => {
    const release = await acquireLocalLease('zero-g-budget:' + budget.file)
    try {
      const state = await readCheckpoint(budget.file)
      validate(state, budget)
      const result = await change(state, budget)
      if (persist) await writeCheckpoint(budget.file, state)
      return result
    } finally { await release() }
  })
  queues.set(budget.file, work.catch(() => {}))
  return work
}

export async function initializeZeroGBudget(configuration, initialSpentUsd = '0') {
  const budget = terms(configuration), spentNanoUsd = usdToNano(initialSpentUsd)
  if (spentNanoUsd > budget.limitNanoUsd) throw Error('INVALID_ZERO_G_BUDGET')
  await mkdir(dirname(budget.file), { recursive: true, mode: 0o700 })
  const release = await acquireLocalLease('zero-g-budget:' + budget.file)
  try {
    const exists = await stat(budget.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (exists) { validate(await readCheckpoint(budget.file), budget); return }
    await writeCheckpoint(budget.file, { version: 1, authorizationId: budget.authorizationId, limitNanoUsd: budget.limitNanoUsd,
      initialSpentNanoUsd: spentNanoUsd, spentNanoUsd, completedRequests: 0, pending: {}, createdAt: new Date().toISOString() })
  } finally { await release() }
}

export async function validateZeroGBudget(budget) {
  await mutate(budget, () => {}, false)
}

export async function reserveZeroGRequest(provider, request, pricing) {
  if (provider.model !== zeroGModel.model || !validPricing(pricing) || Math.abs(Date.now() - Date.parse(pricing.observedAt)) > 60000 || request.model !== provider.model ||
      !count(request.max_tokens) || !request.max_tokens || request.max_tokens > 4096) throw Error('INVALID_ZERO_G_REQUEST_BOUND')
  // Reserve the entire published context, not an optimistic local tokenizer estimate.
  const ceilingNanoUsd = zeroGModel.contextTokens * pricing.inputNanoUsd + request.max_tokens * pricing.outputNanoUsd
  return mutate(provider.budget, (state, budget) => {
    if (state.blockedReason) throw Error('0G budget needs operator reconciliation before more requests.')
    if (validate(state, budget) + ceilingNanoUsd > budget.limitNanoUsd) throw Error('0G API budget exhausted; existing tasks are preserved.')
    const id = randomUUID()
    state.pending[id] = { model: provider.model, inputBound: zeroGModel.contextTokens, maxTokens: request.max_tokens,
      ceilingNanoUsd, pricing, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), createdAt: new Date().toISOString() }
    return id
  })
}

export async function recordZeroGUsage(provider, id, body, requestId, latencyMs) {
  const result = await mutate(provider.budget, state => {
    const pending = state.pending[id], usage = body?.usage
    if (!pending) throw Error('ZERO_G_BUDGET_REQUEST_NOT_PENDING')
    if (body.model !== pending.model || typeof body.id !== 'string' || !body.id ||
        !count(usage?.prompt_tokens) || !count(usage?.completion_tokens) ||
        usage.prompt_tokens > pending.inputBound || usage.completion_tokens > pending.maxTokens ||
        (usage.total_tokens !== undefined && usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)) {
      state.blockedReason = 'Provider usage did not match the reserved model/token bounds.'
      return false
    }
    const costNanoUsd = usage.prompt_tokens * pending.pricing.inputNanoUsd + usage.completion_tokens * pending.pricing.outputNanoUsd
    if (!count(costNanoUsd) || costNanoUsd > pending.ceilingNanoUsd) {
      state.blockedReason = 'Provider cost exceeded the reserved ceiling.'
      return false
    }
    state.spentNanoUsd += costNanoUsd
    state.completedRequests++
    state.lastReceipt = { reservationId: id, responseId: body.id, requestId, model: body.model,
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }, costNanoUsd,
      pricing: pending.pricing, requestSha256: pending.requestSha256, latencyMs, recordedAt: new Date().toISOString() }
    delete state.pending[id]
    return true
  })
  if (!result) throw Error('0G budget needs operator reconciliation before more requests.')
}
