import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createWalletAuth } from '../../backend/src/playable/wallet-auth.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { Pool } = require('pg')
const settings = JSON.parse(await readFile(new URL('../../.local/backend/environment.json', import.meta.url)))
const schema = 'wallet_auth_fixture_' + randomUUID().replaceAll('-', '')
const admin = new Pool({ connectionString: settings.databaseUrl, max: 1 })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c search_path=' + schema, max: 4 })
const alice = { playerId: randomUUID(), playerName: 'WalletAlice', connectionId: randomUUID(), online: true }
const bob = { playerId: randomUUID(), playerName: 'WalletBob', connectionId: randomUUID(), online: true }
const sessions = new Map([[alice.playerId, { ...alice }], [bob.playerId, { ...bob }]])
const claims = subject => ({ subject, appId: 'fixture-app', issuer: 'privy.io', expiresAtMs: Date.now() + 60_000 })
const token = 'fixture-token-not-a-real-Privy-JWT'
let selected = claims('did:privy:fixture-alice'), verifications = 0
const make = () => createWalletAuth({ pool, origin: 'http://127.0.0.1:8789', appId: 'fixture-app', allowedSubjects: { [alice.playerId]: 'did:privy:fixture-alice', [bob.playerId]: 'did:privy:fixture-bob' }, gameSession: async id => sessions.get(id), verifyAccessToken: async value => { assert.equal(value, token); verifications++; return selected } })
try {
  await admin.query('CREATE SCHEMA ' + schema)
  let auth = await make()
  await assert.rejects(auth.requireSession(alice), /WALLET_LOGIN_REQUIRED/)
  const first = await auth.challenge(alice)
  assert(first.loginUrl.startsWith('http://127.0.0.1:8789/player-wallet#challenge='))
  const stored = (await pool.query('SELECT * FROM ac_wallet_login_challenges')).rows[0]
  assert.notEqual(stored.challenge_hash, first.challenge)
  assert.equal((await auth.complete({ challenge: first.challenge, accessToken: token })).verified, true)
  const verified = await auth.requireSession(alice)
  assert.equal(verified.privySubject, 'did:privy:fixture-alice')
  await assert.rejects(auth.complete({ challenge: first.challenge, accessToken: token }), /WALLET_LOGIN_EXPIRED_OR_USED/)
  assert(verifications >= 2)
  console.log('PASS isolated PostgreSQL + explicit JWT/game fixtures: one-use hashed challenge, approved UUID-to-subject enrollment and connection-bound authentication')
  auth = await make()
  assert.equal((await auth.requireSession(alice)).privySubject, verified.privySubject)
  const nextConnection = randomUUID(); sessions.get(alice.playerId).connectionId = nextConnection
  await assert.rejects(auth.requireSession(alice), /WALLET_GAME_SESSION_CHANGED/)
  const reconnect = { ...alice, connectionId: nextConnection }
  await assert.rejects(auth.requireSession(reconnect), /WALLET_LOGIN_REQUIRED/)
  const second = await auth.challenge(reconnect)
  selected = claims('did:privy:fixture-bob')
  await assert.rejects(auth.complete({ challenge: second.challenge, accessToken: token }), /WALLET_IDENTITY_BINDING_CONFLICT/)
  selected = claims('did:privy:fixture-alice')
  await auth.complete({ challenge: second.challenge, accessToken: token })
  assert.equal((await auth.requireSession(reconnect)).connectionId, nextConnection)
  console.log('PASS durable immutable binding survives service restart; reconnect revokes authority and requires the same verified Privy identity')
  const b = await auth.challenge(bob)
  selected = claims('did:privy:unapproved')
  await assert.rejects(auth.complete({ challenge: b.challenge, accessToken: token }), /WALLET_ENROLLMENT_NOT_APPROVED/)
  selected = { ...claims('did:privy:fixture-bob'), expiresAtMs: Date.now() - 1 }
  await assert.rejects(auth.complete({ challenge: b.challenge, accessToken: token }), /WALLET_TOKEN_INVALID/)
  selected = { ...claims('did:privy:fixture-bob'), appId: 'wrong-app' }
  await assert.rejects(auth.complete({ challenge: b.challenge, accessToken: token }), /WALLET_TOKEN_INVALID/)
  selected = claims('did:privy:fixture-bob')
  const newer = await auth.challenge(bob)
  await assert.rejects(auth.complete({ challenge: b.challenge, accessToken: token }), /WALLET_LOGIN_EXPIRED_OR_USED/)
  sessions.get(bob.playerId).connectionId = randomUUID()
  await assert.rejects(auth.complete({ challenge: newer.challenge, accessToken: token }), /WALLET_GAME_SESSION_CHANGED/)
  assert.equal((await pool.query('SELECT count(*)::int n FROM ac_wallet_identity_bindings')).rows[0].n, 1)
  console.log('PASS wrong app, expired JWT, unapproved subject, superseded challenge and stale game session fail without enrolling or authorizing crypto')
} finally {
  await pool.end()
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await admin.end()
}
