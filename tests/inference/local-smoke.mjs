import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { requestProposal } from '../../backend/src/inference/proposal.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const reportDir = join(root, 'evidence/runs/p1-boundary/agentcity-boundary-130eaeb3/retained/reports')
const reports = await Promise.all((await readdir(reportDir)).map(async name => JSON.parse(await readFile(join(reportDir, name), 'utf8'))))
const failed = reports.find(report => report.status === 'FAIL')
assert.equal(failed.rows.filter(row => row.expected === row.observed).length, 10)
const blueprint = JSON.parse(await readFile(join(root, 'fixtures/blueprints/calculator-v1.json'), 'utf8'))
const deployment = JSON.parse(await readFile(join(root, 'evidence/runs/p1-boundary/agentcity-boundary-130eaeb3/deployment.json'), 'utf8'))
const carry = blueprint.outputs.find(output => output.name === 'c1').source_position
const origin = [4, 1, 4]
const target = carry.map((value, index) => value + origin[index] + deployment.plotMin[index])
const context = {
  jobId: failed.context.jobId, expectedRevision: failed.revision, report: failed,
  lockMode: 'NONE', authorizedRepair: true, authorizedInspection: true,
  carrySourceMissing: true, availableTorches: 1, approvedCarrySource: target,
  source: 'retained_game_report_with_scripted_local_authorization_context'
}
let reply = { action: 'repair_carry', reason: 'Inspect the observed missing high-carry feed.' }
let status = 200
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer local-fixture-only')
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    assert.equal(body.model, 'scripted-fixture')
    assert.equal(body.max_tokens, 256)
    assert.equal(JSON.parse(body.messages[1].content).report.status, 'FAIL')
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(status === 200
      ? { id: 'local-fixture-response', choices: [{ message: { content: JSON.stringify(reply) } }] }
      : { error: 'fixture_provider_unavailable' }))
  } catch {
    response.writeHead(400).end('{}')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', model: 'scripted-fixture' }
const results = []
try {
  let result = await requestProposal(config, context)
  assert.equal(result.proposal.action, 'repair_carry')
  assert.deepEqual(result.proposal.target, target)
  assert.equal(result.evidence.live0GVerified, false)
  results.push({ check: 'real_10_of_16_report_to_scoped_repair_proposal', status: 'pass' })
  reply = { action: 'inspect', reason: 'Request a fresh deterministic inspection.' }
  result = await requestProposal(config, context)
  assert.equal(result.proposal.action, 'inspect')
  results.push({ check: 'inspection_proposal', status: 'pass' })
  reply = { action: 'mint', reason: 'Create funds.' }
  result = await requestProposal(config, context)
  assert.equal(result.proposal.action, 'wait')
  assert.equal(result.evidence.failure, 'invalid_proposal')
  results.push({ check: 'money_action_refused', status: 'pass' })
  reply = { action: 'repair_carry', reason: 'Repair.' }
  result = await requestProposal(config, { ...context, availableTorches: 0 })
  assert.equal(result.proposal.action, 'wait')
  results.push({ check: 'missing_materials_wait', status: 'pass' })
  status = 503
  result = await requestProposal(config, context)
  assert.equal(result.proposal.action, 'wait')
  assert.equal(result.evidence.failure, 'provider_http_503')
  results.push({ check: 'provider_unavailable_wait', status: 'pass' })
} finally {
  await new Promise(resolve => server.close(resolve))
}
const output = resolve(root, '.local/inference/local-smoke.json')
await mkdir(resolve(root, '.local/inference'), { recursive: true })
await writeFile(output, JSON.stringify({
  scope: 'P3 preparation only; scripted local HTTP fixture, not an LLM, not 0G, no execution or billing proof',
  sourceReport: failed.runId, results, executedMinecraftActions: 0, externalCalls: 0, providerSpend: 0
}, null, 2) + '\n')
console.log(`PASS ${results.length}/${results.length}: scripted local inference preparation; no real 0G call, no world mutation, no spend`)
