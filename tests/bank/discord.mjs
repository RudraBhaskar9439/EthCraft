// Transport fixtures only. No Discord network, signing, chain or world actions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createBankDiscordRuntime } from '../../backend/src/discord/bank-runtime.mjs'
const owner = randomUUID(), other = randomUUID(), userId = '123456789012345678', calls = []
const saved = { operationId: 'bank:one', status: 'preview', consented: false, termsDigest: 'a'.repeat(64), message: 'Review exact terms' }
const service = {
  async preview(request) { calls.push(request); assert.equal(request.principalId, owner); return saved },
  async status(request) { assert.equal(request.principalId, owner); return saved },
  async confirm(request) { assert.equal(request.principalId, owner); assert.equal(request.termsDigest, saved.termsDigest); calls.push(request); return { ...saved, status: 'complete', consented: true } },
  async history(request) { return request }, async loans(request) { return request }, async credits(request) { return request }, async works(request) { return request }
}
const identity = { async getOwner(id) { return { ownerId: owner, discordUserId: id } } }
const runtime = await createBankDiscordRuntime({ identity, service })
const result = await runtime.handleDiscord({ userId, operationId: 'interaction:one', action: 'borrow', args: { principalId: other, operationId: 'spoofed', loanId: '0x' + '1'.repeat(64) } })
assert.equal(calls[0].operationId, 'interaction:one'); assert.equal(result.confirmation.kind, 'bank')
await assert.rejects(runtime.handleDiscord({ userId, operationId: 'retry', action: 'retry', args: { operationId: saved.operationId } }), /BANK_CONFIRM_BEFORE_RETRY/)
const confirmed = await runtime.handleDiscord({ userId, operationId: 'interaction:confirm', action: 'confirm', args: { operationId: saved.operationId, termsDigest: 'spoofed' } })
assert.equal(confirmed.confirmation, null); assert.equal(calls[1].confirmationId, 'interaction:confirm')
assert.equal((await runtime.handleDiscord({ userId, action: 'history' })).principalId, owner)
const denied = await createBankDiscordRuntime({ identity: { getOwner: async () => ({ ownerId: owner, discordUserId: 'different' }) }, service })
await assert.rejects(denied.handleDiscord({ userId, action: 'credits' }), /BANK_DISCORD_OWNER_REQUIRED/)
console.log(JSON.stringify({ status: 'pass', checks: 5, scope: 'Discord transport fixtures only; no financial or world effect' }))
