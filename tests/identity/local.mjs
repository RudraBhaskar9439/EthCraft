import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostgresStore } from '../../backend/src/storage/postgres.mjs'
import { createIdentityService } from '../../backend/src/identity/service.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { privateKeyToAccount } = require('viem/accounts')
const root = fileURLToPath(new URL('../../', import.meta.url))
const environment = JSON.parse(await readFile(path.join(root, '.local/backend/environment.json'), 'utf8'))
const runId = 'identity-' + randomUUID()
const output = path.join(root, 'evidence/runs/local-p4', runId)
await mkdir(output, { recursive: true })
const report = { schema: 'agentcity.local-p4.identity.v1', runId, status: 'fail', checks: [], independentHumans: 0, liveGameSessionVerified: false, sessionAuthority: 'PostgreSQL-backed scripted local session fixture', startedAt: new Date().toISOString() }
const serverId = 'local-p4-' + randomUUID()
const playerUuid = randomUUID()
const sessionId = randomUUID()
let authorityNow = Date.now()
let store = new PostgresStore(environment.databaseUrl)
// Public disposable signing fixtures; these are not the user's wallet accounts.
const requester = privateKeyToAccount('0x' + '11'.repeat(32))
const stranger = privateKeyToAccount('0x' + '22'.repeat(32))
const context = { serverId, origin: 'http://127.0.0.1:3000', chainId: 31337 }
function service(database) {
  return createIdentityService({ store: database, context, clock: () => authorityNow,
    resolveSession: async (binding, { transaction }) => {
      const { rows } = await (transaction || database).query('SELECT * FROM identity_test_sessions WHERE server_id=$1 AND player_uuid=$2 AND session_id=$3 FOR SHARE', [binding.serverId, binding.playerUuid, binding.sessionId])
      return rows[0] ? { serverId: rows[0].server_id, playerUuid: rows[0].player_uuid, sessionId: rows[0].session_id, expiresAtMs: Number(rows[0].expires_at_ms) } : null
    }
  })
}
const check = (name, details = {}) => report.checks.push({ name, status: 'pass', ...details })
const request = challenge => ({ challengeId: challenge.id, playerUuid, sessionId, wallet: requester.address })

try {
  await store.migrate([path.join(root, 'backend/src/identity/schema.sql')])
  await store.query('CREATE TABLE IF NOT EXISTS identity_test_sessions(server_id text,player_uuid uuid,session_id text,expires_at_ms bigint,PRIMARY KEY(server_id,player_uuid,session_id))')
  await store.query('INSERT INTO identity_test_sessions VALUES($1,$2,$3,$4)', [serverId, playerUuid, sessionId, authorityNow + 3600000])
  let identity = service(store)
  const challenge = await identity.issueChallenge({ playerUuid, sessionId, wallet: requester.address })
  const signature = await requester.signTypedData(challenge.typedData)
  const concurrent = await Promise.allSettled([identity.linkWallet({ ...request(challenge), signature }), identity.linkWallet({ ...request(challenge), signature })])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'CHALLENGE_ALREADY_CONSUMED')
  assert.equal((await identity.getLink(playerUuid)).wallet, requester.address.toLowerCase())
  check('real-eip712-signature-and-atomic-single-consumption', { concurrentAttempts: 2, accepted: 1 })

  await store.close()
  store = new PostgresStore(environment.databaseUrl)
  identity = service(store)
  await assert.rejects(identity.linkWallet({ ...request(challenge), signature }), { code: 'CHALLENGE_ALREADY_CONSUMED' })
  check('consumed-nonce-survives-service-and-connection-recreation')

  const wrongSigner = await identity.issueChallenge({ playerUuid, sessionId, wallet: requester.address })
  await assert.rejects(identity.linkWallet({ ...request(wrongSigner), signature: await stranger.signTypedData(wrongSigner.typedData) }), { code: 'INVALID_WALLET_SIGNATURE' })
  await identity.linkWallet({ ...request(wrongSigner), signature: await requester.signTypedData(wrongSigner.typedData) })
  check('wrong-signer-refused-without-consuming-valid-challenge')

  const expired = await identity.issueChallenge({ playerUuid, sessionId, wallet: requester.address })
  const expiredSignature = await requester.signTypedData(expired.typedData)
  authorityNow = expired.expiresAtMs
  await assert.rejects(identity.linkWallet({ ...request(expired), signature: expiredSignature }), { code: 'CHALLENGE_EXPIRED' })
  check('expiry-equality-refused-by-authority-clock')

  const staleSession = await identity.issueChallenge({ playerUuid, sessionId, wallet: requester.address })
  await assert.rejects(identity.linkWallet({ ...request(staleSession), sessionId: randomUUID(), signature: await requester.signTypedData(staleSession.typedData) }), { code: 'CHALLENGE_CONTEXT_MISMATCH' })
  await store.query('UPDATE identity_test_sessions SET expires_at_ms=$4 WHERE server_id=$1 AND player_uuid=$2 AND session_id=$3', [serverId, playerUuid, sessionId, authorityNow])
  await assert.rejects(identity.linkWallet({ ...request(staleSession), signature: await requester.signTypedData(staleSession.typedData) }), { code: 'LIVE_GAME_SESSION_REQUIRED' })
  check('changed-session-and-logged-out-player-refused')

  await store.query('UPDATE identity_test_sessions SET expires_at_ms=$4 WHERE server_id=$1 AND player_uuid=$2 AND session_id=$3', [serverId, playerUuid, sessionId, authorityNow + 3600000])
  const relink = await identity.issueChallenge({ playerUuid, sessionId, wallet: stranger.address })
  await assert.rejects(identity.linkWallet({ challengeId: relink.id, playerUuid, sessionId, wallet: stranger.address, signature: await stranger.signTypedData(relink.typedData) }), { code: 'RELINK_REQUIRES_BOTH_WALLETS' })
  assert.equal((await identity.getLink(playerUuid)).wallet, requester.address.toLowerCase())
  check('unilateral-relink-refused-and-existing-binding-preserved')
  report.database = (await store.query('SELECT version() AS version')).rows[0].version
  report.status = 'pass'
} catch (error) {
  report.error = { code: error.code, message: error.message }
  process.exitCode = 1
} finally {
  await store.query('DELETE FROM identity_links WHERE server_id=$1', [serverId])
  await store.query('DELETE FROM identity_challenges WHERE server_id=$1', [serverId])
  await store.query('DELETE FROM identity_test_sessions WHERE server_id=$1', [serverId])
  await store.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence: path.relative(root, output), error: report.error }))
}
