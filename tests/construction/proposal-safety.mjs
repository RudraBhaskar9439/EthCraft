import assert from 'node:assert/strict'
import { runLocalProposal } from '../../backend/src/bot/proposal-gate.mjs'

// Focused local-model checks: inference must never bypass changed state or protected review.
let effects = 0
let reads = 0
const changed = await runLocalProposal({ action: 'construct',
  observe: async () => ({ jobId: 'local-safety-job', expectedRevision: ++reads, lockMode: 'NONE', authorizedConstruction: true }),
  execute: async () => effects++ })
assert.equal(changed.evidence.mode, 'ollama_local')
assert.equal(changed.evidence.failure, undefined)
assert.equal(changed.status, 'waiting')
assert.equal(changed.proposal.reason, 'job_changed_during_inference')
assert.equal(effects, 0)
const locked = await runLocalProposal({ action: 'construct',
  observe: async () => ({ jobId: 'local-safety-job', expectedRevision: 1, lockMode: 'REVIEW', authorizedConstruction: true }),
  execute: async () => effects++ })
assert.equal(locked.evidence.mode, 'ollama_local')
assert.equal(locked.evidence.failure, undefined)
assert.equal(locked.status, 'waiting')
assert.equal(locked.proposal.action, 'wait')
assert.equal(effects, 0)
console.log(JSON.stringify({ status: 'pass', effects, checks: [{ name: 'changed-revision-rejected-after-real-inference', ...changed }, { name: 'review-lock-prevents-execution', ...locked }] }, null, 2))
