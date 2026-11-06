import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { validateHumanSessionInput, assertHumanSessionOperation } from '../../backend/src/workflow/human-session.mjs'

// Pure boundary fixtures: no runtime, database, public RPC, wallets or signing keys are opened.
const checks = []
const operationId = randomUUID(), transactionHash = '0x' + 'ab'.repeat(32)
const actions = ['approve_escrow', 'fund', 'approve_procurement', 'buy', 'accept', 'claim', 'refund']
function check(name, run) { run(); checks.push(name) }

try {
  check('Only the exact documented fields are accepted for every controller action', () => {
    for (const action of ['status', 'start', 'register', 'provision', 'publish', 'advance']) assert.doesNotThrow(() => validateHumanSessionInput(action, {}))
    for (const role of ['requester', 'builder']) assert.doesNotThrow(() => validateHumanSessionInput('identity', { role }))
    for (const action of actions) assert.doesNotThrow(() => validateHumanSessionInput('prepare', { action }))
    for (const action of ['begin', 'reconcile', 'rejected']) assert.doesNotThrow(() => validateHumanSessionInput(action, { operationId }))
    assert.doesNotThrow(() => validateHumanSessionInput('submitted', { operationId, transactionHash }))
  })

  check('Browser input cannot supply wallet authority or arbitrary transaction contents', () => {
    for (const field of ['wallet', 'actor', 'from', 'to', 'data', 'calldata', 'agreementHash', 'identityServerId', 'playerUuid', 'sessionId']) {
      assert.throws(() => validateHumanSessionInput('start', { [field]: 'untrusted' }))
      assert.throws(() => validateHumanSessionInput('prepare', { action: 'buy', [field]: 'untrusted' }))
      assert.throws(() => validateHumanSessionInput('submitted', { operationId, transactionHash, [field]: 'untrusted' }))
    }
    assert.throws(() => validateHumanSessionInput('submit_raw_transaction', { transactionHash }))
    for (const value of [null, [], 'body', 1]) assert.throws(() => validateHumanSessionInput('start', value))
    assert.throws(() => validateHumanSessionInput('identity', { role: 'operator' }))
    assert.throws(() => validateHumanSessionInput('prepare', { action: 'transfer' }))
    assert.throws(() => validateHumanSessionInput('begin', { operationId: 'not-a-uuid' }))
    assert.throws(() => validateHumanSessionInput('submitted', { operationId, transactionHash: '0xab' }))
    assert.throws(() => validateHumanSessionInput('submitted', { operationId }))
  })

  check('Operation authority comes from the pinned workflow IDs', () => {
    const demo = { operation_ids: Object.fromEntries(actions.map(action => [action, randomUUID()])) }
    for (const [action, id] of Object.entries(demo.operation_ids)) assert.deepEqual(assertHumanSessionOperation(demo, id), { action, role: action === 'claim' ? 'builder' : 'requester' })
    assert.throws(() => assertHumanSessionOperation(demo, randomUUID()))
    assert.throws(() => assertHumanSessionOperation(demo, 'not-a-uuid'))
    assert.throws(() => assertHumanSessionOperation({ operation_ids: { fund: operationId, buy: operationId } }, operationId))
  })

  console.log(JSON.stringify({ status: 'pass', checks, scope: 'Pure local authority boundary fixtures; no runtime or network access.' }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks, message: error.message }))
  process.exitCode = 1
}
