import { requestProposal, validateProposal } from './proposal.mjs'
import { isDeepStrictEqual } from 'node:util'

function binding(context) {
  const fields = ['jobId', 'actorId', 'sessionGeneration', 'expectedRevision', 'leaseEpoch', 'leaseUntilMs', 'agreementDigest']
  const result = Object.fromEntries(fields.map(field => [field, context[field]]))
  if (fields.some(field => result[field] === undefined) || !Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0 ||
      !Number.isSafeInteger(context.sessionGeneration) || context.sessionGeneration < 0 ||
      !Number.isSafeInteger(context.leaseEpoch) || context.leaseEpoch < 1 ||
      !Number.isSafeInteger(context.leaseUntilMs) || context.leaseUntilMs < 1) throw new Error('invalid_execution_context')
  return result
}

export class DecisionService {
  constructor({ repository, provider, observe, clock = Date.now }) {
    this.repository = repository
    this.provider = provider
    this.observe = observe
    this.clock = clock
  }

  async propose(jobId) {
    const context = await this.observe(jobId)
    const authority = binding(context)
    if (context.jobId !== jobId || context.leaseUntilMs <= this.clock()) throw new Error('execution_context_expired')
    const attemptId = await this.repository.reserveAttempt(jobId)
    const result = await requestProposal(this.provider, context)
    return this.repository.recordDecision(jobId, attemptId, result, authority)
  }

  async execute(proposalId) {
    const decision = await this.repository.getDecision(proposalId)
    if (!decision) throw new Error('unknown_proposal')
    const current = await this.observe(decision.job_id)
    const authority = binding(current)
    if (!isDeepStrictEqual(authority, decision.binding) || current.leaseUntilMs <= this.clock()) throw new Error('execution_context_changed')
    const proposal = validateProposal(JSON.stringify({ action: decision.proposal.action, reason: decision.proposal.reason }), current)
    if (proposal.action === 'wait') return { status: 'waiting', reason: proposal.reason }
    if (current.lockMode !== 'NONE' || current.quarantined || current.actorAuthorized !== true) throw new Error('execution_not_authorized')
    const operationId = await this.repository.enqueueDecision(proposalId, authority, proposal.action, {
      ...proposal, actorId: current.actorId, sessionGeneration: current.sessionGeneration,
      leaseEpoch: current.leaseEpoch, expiresAtMs: Math.min(current.leaseUntilMs, this.clock() + 8000)
    })
    return { status: 'queued', proposalId, operationId }
  }
}
