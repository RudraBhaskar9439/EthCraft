import assert from 'node:assert/strict'
import { approvalState, signPrepared } from '../../backend/src/web/wallet.mjs'

const pending = { state: 'pending', expiresAtMs: 1000 }
assert.equal(approvalState(pending, 999), 'pending')
assert.equal(approvalState(pending, 1000), 'expired')
assert.equal(approvalState({ state: 'approved', expiresAtMs: 1000 }, 2000), 'approved')
let calls = 0
const provider = { request() { calls++; throw new Error('An expired request must not open a wallet prompt') } }
await assert.rejects(signPrepared(provider, { state: 'pending', expiresAtMs: Date.now() - 1 }, true), /expired/)
assert.equal(calls, 0)
console.log('PASS expired approval blocks signing before any wallet call; exact expiry and recorded approvals remain correct')
