// Deterministic scheduler and publisher fixtures; no RPC, keys, signatures or funds.
import assert from 'node:assert/strict'
import {createPoolObservationKeeper} from '../../backend/src/bank/pool-observation-keeper.mjs'

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture(publish, acquire) {
  const waits = [], records = []
  let released = 0, leases = 0
  const keeper = createPoolObservationKeeper({publish,
    acquireLease: async () => { leases++; if (acquire) await acquire(); return async () => { released++ } },
    record: async state => { records.push(structuredClone(state)) },
    pause: (milliseconds, _, {signal}) => {
      assert.equal(milliseconds, 30000)
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))
        signal.addEventListener('abort', abort, {once: true})
        waits.push(() => { signal.removeEventListener('abort', abort); resolve() })
      })
    }})
  return {keeper, records, next: async () => { assert(waits.length); waits.shift()(); await settle() },
    released: () => released, leases: () => leases}
}

let calls = 0
const continuous = fixture(async () => { calls++; return {pending: false, proof: {transactionHash: 'fixture-' + calls}} })
continuous.keeper.start(); await settle()
assert.equal(continuous.keeper.start().started, false)
for (let i = 0; i < 13; i++) await continuous.next()
assert.equal(calls, 14); assert.equal(continuous.leases(), 1)
await continuous.keeper.stop()
assert.equal(continuous.released(), 1); assert.equal(calls, 14)
console.log('PASS keeper continues beyond twelve samples, owns one lease, and stops without overlapping publication')

calls = 0
const interrupted = fixture(async () => {
  calls++; if (calls === 1) throw Error('lost_checkpoint_reply')
  return {pending: calls === 2, proof: {transactionHash: 'same-retained-checkpoint'}}
})
interrupted.keeper.start(); await settle()
assert.equal(interrupted.keeper.status().status, 'retrying')
await interrupted.next(); assert.equal(interrupted.keeper.status().status, 'pending')
await interrupted.next(); assert.equal(interrupted.keeper.status().status, 'running')
await interrupted.keeper.stop()
console.log('PASS transient errors and pending receipts retry the receiving publisher without fabricating readiness')

calls = 0
const exhausted = fixture(async () => { calls++; throw Error('testnet_native_budget_exhausted') })
exhausted.keeper.start(); await settle()
assert.equal(exhausted.keeper.status().status, 'blocked'); assert.equal(calls, 1)
assert.equal(exhausted.keeper.status().error, 'TESTNET_NATIVE_BUDGET_EXHAUSTED')
assert.equal(exhausted.released(), 1)
await exhausted.keeper.stop(); assert.equal(calls, 1)
console.log('PASS exhausted gas budget stops the keeper without resets or replacement transactions')

let busy = true
calls = 0
const waiting = fixture(async () => { calls++; return {pending: false} }, async () => {
  if (busy) throw Object.assign(Error('busy'), {code: 'EADDRINUSE'})
})
waiting.keeper.start(); await settle()
assert.equal(waiting.keeper.status().status, 'waiting_for_keeper'); assert.equal(calls, 0)
busy = false; await waiting.next(); assert.equal(calls, 1)
await waiting.keeper.stop(); assert.equal(waiting.released(), 1)
console.log('PASS an existing manual warm-up retains ownership until its lease is released')
