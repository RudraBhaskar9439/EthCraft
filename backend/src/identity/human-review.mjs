import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { getAddress, keccak256, stringToHex } from 'viem'
import { openWalletHandoffs } from './http-runtime.mjs'
import { prepareAgreement } from '../agreements/service.mjs'
import { AGREEMENT_REVIEW_WINDOW_MS } from './handoff.mjs'

const root = new URL('../../../', import.meta.url)
const activePath = new URL('.local/human-approvals/active.json', root)

async function retainedReview(service, origin, accounts) {
  let active
  try { active = JSON.parse(await readFile(activePath, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  assert.match(active.directory, /^\.local\/human-approvals\/[a-f0-9-]{36}\/$/)
  const links = []
  for (const [role, account] of Object.entries(accounts)) {
    const file = JSON.parse(await readFile(new URL(active.directory + role + '.json', root), 'utf8'))
    const url = new URL(file.url), fragment = new URLSearchParams(url.hash.slice(1))
    assert.equal(url.origin, origin)
    assert.equal(url.pathname, '/wallet')
    const request = await service.get(fragment.get('id'), fragment.get('token'))
    if (request.expectedAccount !== account.toLowerCase()) return null
    assert.equal(request.reference.agreementHash, active.agreementHash)
    assert.equal(file.id, request.id)
    links.push({ role, account, url: file.url, state: request.state, expiresAtMs: request.expiresAtMs })
  }
  if (links.every(link => link.state === 'expired')) return null
  return { status: 'prepared', agreementHash: active.agreementHash,
    expiresAtMs: Math.min(...links.map(link => link.expiresAtMs)), links,
    walletApprovalsRecorded: links.filter(link => link.state === 'approved').length, transactionsSubmitted: 0 }
}

/** Trusted local operator only; returned links contain private request capabilities. */
export async function prepareHumanReview({ requester = '0xd1DcAAFf9356d5a42f2eE6F90179C4509386a83f', builder,
  origin = 'http://127.0.0.1:8789', checkOnly = false, reuseActive = false }) {
  requester = getAddress(requester); builder = getAddress(builder)
  assert.notEqual(requester.toLowerCase(), builder.toLowerCase(), 'Two distinct participant wallets are required')
  const runtime = await openWalletHandoffs(origin)
  try {
    const { context, agreements, service } = runtime
    if (reuseActive && !checkOnly) {
      const retained = await retainedReview(service, origin, { requester, builder })
      if (retained) return retained
    }
    const nowMs = Date.now(), now = BigInt(Math.floor(nowMs / 1000)), id = randomUUID()
    const hash = value => keccak256(stringToHex(value))
    const input = {
      terms: { jobId: hash('human-demo-' + id), serverId: context.serverId, version: '1', requester, builder,
        cred: context.cred, kit: context.kit, bundleHash: context.bundleHash, blueprintHash: context.blueprintHash,
        testsHash: context.testsHash, accessHash: context.accessHash, materialCap: '3000000000000000000',
        workDeadline: String(now + 3600n), reviewDeadline: String(now + 4500n), passDeadline: String(now + 4500n), absoluteExpiry: String(now + 4500n) },
      scope: { worldId: 'synthetic-human-demo-' + id, plotMin: [-16, 80, -8], plotMax: [15, 95, 7], blueprintOrigin: [-12, 81, -4], stockChest: [-14, 81, 5],
        orientation: 'identity', startAt: String(now), approvalExpiresAtMs: String(nowMs + AGREEMENT_REVIEW_WINDOW_MS),
        ownershipPolicyHash: hash('requester owns simulated materials in the separate contract demonstration'),
        refundPolicyHash: hash('unaccepted timeout refund; accepted allocations stay claimable'),
        inferenceBudgetMicrousd: '0', nativeGasBudgetWei: '8000000000000000' },
      allocations: [{ recipient: builder, amount: '6000000000000000000' }]
    }
    const canonical = prepareAgreement({ ...input, domain: context.domain })
    assert.equal(canonical.domain.chainId, 1301)
    assert.ok(canonical.scope.worldId.startsWith('synthetic-human-demo-'))
    if (checkOnly) return { status: 'pass', scope: 'Draft validation only; no request, signature or transaction created', requester, builder, agreementHash: canonical.hash }
    const prepared = await agreements.create(input, requester)
    assert.equal(prepared.hash, canonical.hash)
    assert.equal(prepared.state, 'proposed')
    assert.equal(prepared.approvals.length, 0)
    const relativeDirectory = '.local/human-approvals/' + id + '/', directory = new URL(relativeDirectory, root)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const links = []
    for (const [role, account] of Object.entries({ requester, builder })) {
      const handoff = await service.prepareAgreement({ agreementHash: prepared.hash, account })
      const url = origin + '/wallet#' + handoff.urlFragment
      await writeFile(new URL(role + '.json', directory), JSON.stringify({ id: handoff.id, agreementHash: prepared.hash, url }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      const safeLink = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      await writeFile(new URL(role + '.html', directory), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + safeLink + '"><title>Private approval link</title><a href="' + safeLink + '">Open your prepared approval</a>', { mode: 0o600, flag: 'wx' })
      links.push({ role, account, url, state: 'pending', expiresAtMs: handoff.expiresAtMs })
    }
    const temporary = new URL('.local/human-approvals/active-' + id + '.json', root)
    await writeFile(temporary, JSON.stringify({ directory: relativeDirectory, agreementHash: prepared.hash, recordedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, activePath)
    return { status: 'prepared', agreementHash: prepared.hash, privateDirectory: directory.pathname,
      expiresAtMs: Math.min(...links.map(link => link.expiresAtMs)), links, realHumanApprovals: 0, walletApprovalsRecorded: 0, transactionsSubmitted: 0 }
  } finally { await runtime.close() }
}
