import { requestProposal, validateProposal } from '../inference/proposal.mjs'
import { localOllama } from '../inference/providers.mjs'

// The model selects a bounded action. Existing worker/plugin authority controls every effect.
export async function runLocalProposal({ action, observe, execute }) {
  if (!['construct', 'inspect'].includes(action)) throw new Error('unsupported_local_action')
  const before = await observe()
  if (typeof before.jobId !== 'string' || !Number.isSafeInteger(before.expectedRevision)) throw new Error('missing_local_job_context')
  const result = await requestProposal(localOllama, before)
  const fresh = await observe()
  if (fresh.jobId !== before.jobId || fresh.expectedRevision !== before.expectedRevision) {
    return { status: 'waiting', proposal: { action: 'wait', reason: 'job_changed_during_inference' }, evidence: result.evidence }
  }
  const proposal = validateProposal(JSON.stringify({ action: result.proposal.action, reason: result.proposal.reason }), fresh)
  if (proposal.action !== action) return { status: 'waiting', proposal, evidence: result.evidence }
  return { status: 'executed', proposal, evidence: { ...result.evidence, executed: true }, result: await execute() }
}
