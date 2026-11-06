import { randomBytes, createHash } from 'node:crypto'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SUBJECT = /^did:privy:[A-Za-z0-9:_-]{1,200}$/
const fail = code => { throw Object.assign(Error(code), { code }) }
const hash = value => createHash('sha256').update(value).digest('hex')
const schema = `
CREATE TABLE IF NOT EXISTS ac_wallet_login_challenges (
 challenge_hash text PRIMARY KEY, player_id uuid NOT NULL, player_name text NOT NULL,
 connection_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS ac_wallet_identity_bindings (
 player_id uuid PRIMARY KEY, privy_subject text NOT NULL UNIQUE,
 player_name text NOT NULL, app_id text NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ac_wallet_verified_sessions (
 player_id uuid PRIMARY KEY REFERENCES ac_wallet_identity_bindings(player_id),
 privy_subject text NOT NULL, connection_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 authenticated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);`

// The official SDK verifies signature, issuer, intended app and expiration.
// Tokens and app secrets are never persisted by this module.
export async function createPrivyTokenVerifier({ appId, appSecret }) {
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret) fail('PRIVY_AUTH_NOT_CONFIGURED')
  const { PrivyClient } = await import('@privy-io/node')
  const client = new PrivyClient({ appId, appSecret })
  return async accessToken => {
    const claims = await client.utils().auth().verifyAccessToken(accessToken)
    if (claims.app_id !== appId || claims.issuer !== 'privy.io') fail('WALLET_TOKEN_INVALID')
    return { subject: claims.user_id, appId: claims.app_id, issuer: claims.issuer, expiresAtMs: claims.expiration * 1000 }
  }
}

export async function createWalletAuth({ pool, verifyAccessToken, gameSession, allowedSubjects = {}, origin, appId } = {}) {
  if (!pool?.query || !pool?.connect || typeof verifyAccessToken !== 'function' || typeof gameSession !== 'function') fail('WALLET_AUTH_CONFIGURATION_REQUIRED')
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('WALLET_AUTH_ORIGIN_REQUIRED')
  await pool.query(schema)
  function identity(event, nameRequired = true) {
    if (!event || !UUID.test(event.playerId || '') || !UUID.test(event.connectionId || '') || nameRequired && !/^[A-Za-z0-9_]{3,16}$/.test(event.playerName || '')) fail('WALLET_GAME_SESSION_REQUIRED')
    return { ...event, playerId: event.playerId.toLowerCase(), connectionId: event.connectionId.toLowerCase() }
  }
  async function current(event) {
    const live = await gameSession(event.playerId)
    if (!live?.online || live.playerId?.toLowerCase() !== event.playerId || live.connectionId?.toLowerCase() !== event.connectionId || live.playerName && event.playerName && live.playerName !== event.playerName) fail('WALLET_GAME_SESSION_CHANGED')
    return live
  }
  function enrollmentAllowed(playerId, subject) {
    // Prefer exact operator-authorized UUID -> Privy subject enrollment. No
    // username can enroll itself or choose somebody else's approved identity.
    if (allowedSubjects instanceof Map) return allowedSubjects.get(playerId) === subject
    return allowedSubjects && !Array.isArray(allowedSubjects) && allowedSubjects[playerId] === subject
  }
  async function transaction(work) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async function challenge(input) {
    const event = identity(input); await current(event)
    const capability = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 10 * 60_000
    await transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wallet-auth:' + event.playerId])
      await current(event)
      await tx.query('UPDATE ac_wallet_login_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE player_id=$1 AND consumed_at IS NULL', [event.playerId])
      await tx.query('INSERT INTO ac_wallet_login_challenges(challenge_hash,player_id,player_name,connection_id,expires_at) VALUES($1,$2,$3,$4,$5)', [hash(capability), event.playerId, event.playerName, event.connectionId, new Date(expiresAt)])
    })
    return { loginUrl: origin + '/player-wallet#challenge=' + capability, challenge: capability, expiresAt: new Date(expiresAt).toISOString() }
  }
  async function complete({ challenge: capability, accessToken } = {}) {
    if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) || typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 16384) fail('WALLET_LOGIN_INVALID')
    let claims
    try { claims = await verifyAccessToken(accessToken) } catch { fail('WALLET_TOKEN_INVALID') }
    if (!claims || !SUBJECT.test(claims.subject || '') || claims.issuer !== 'privy.io' || typeof claims.appId !== 'string' || !claims.appId || appId && claims.appId !== appId || !Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs <= Date.now()) fail('WALLET_TOKEN_INVALID')
    return transaction(async tx => {
      const lookup = (await tx.query('SELECT player_id FROM ac_wallet_login_challenges WHERE challenge_hash=$1', [hash(capability)])).rows[0]
      if (!lookup) fail('WALLET_LOGIN_EXPIRED_OR_USED')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wallet-auth:' + lookup.player_id])
      const row = (await tx.query('SELECT * FROM ac_wallet_login_challenges WHERE challenge_hash=$1 FOR UPDATE', [hash(capability)])).rows[0]
      if (!row || row.consumed_at || +new Date(row.expires_at) <= Date.now()) fail('WALLET_LOGIN_EXPIRED_OR_USED')
      const event = identity({ playerId: row.player_id, playerName: row.player_name, connectionId: row.connection_id })
      await current(event)
      const binding = (await tx.query('SELECT * FROM ac_wallet_identity_bindings WHERE player_id=$1', [event.playerId])).rows[0]
      if (binding && (binding.privy_subject !== claims.subject || binding.app_id !== claims.appId)) fail('WALLET_IDENTITY_BINDING_CONFLICT')
      if (!binding) {
        if (!enrollmentAllowed(event.playerId, claims.subject)) fail('WALLET_ENROLLMENT_NOT_APPROVED')
        const other = (await tx.query('SELECT player_id FROM ac_wallet_identity_bindings WHERE privy_subject=$1', [claims.subject])).rows[0]
        if (other) fail('WALLET_IDENTITY_BINDING_CONFLICT')
        try { await tx.query('INSERT INTO ac_wallet_identity_bindings(player_id,privy_subject,player_name,app_id) VALUES($1,$2,$3,$4)', [event.playerId, claims.subject, event.playerName, claims.appId]) }
        catch (error) { if (error.code === '23505') fail('WALLET_IDENTITY_BINDING_CONFLICT'); throw error }
      }
      await current(event)
      if (claims.expiresAtMs <= Date.now()) fail('WALLET_TOKEN_INVALID')
      await tx.query('INSERT INTO ac_wallet_verified_sessions(player_id,privy_subject,connection_id,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(player_id) DO UPDATE SET privy_subject=EXCLUDED.privy_subject,connection_id=EXCLUDED.connection_id,expires_at=EXCLUDED.expires_at,authenticated_at=CURRENT_TIMESTAMP', [event.playerId, claims.subject, event.connectionId, new Date(claims.expiresAtMs)])
      await tx.query('UPDATE ac_wallet_login_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE challenge_hash=$1', [hash(capability)])
      return { verified: true, playerId: event.playerId, playerName: event.playerName, privySubject: claims.subject, connectionId: event.connectionId, expiresAt: new Date(claims.expiresAtMs).toISOString() }
    })
  }
  async function requireSession(input) {
    const event = identity(input, false); await current(event)
    const row = (await pool.query('SELECT s.*,b.app_id FROM ac_wallet_verified_sessions s JOIN ac_wallet_identity_bindings b ON b.player_id=s.player_id AND b.privy_subject=s.privy_subject WHERE s.player_id=$1', [event.playerId])).rows[0]
    if (!row || row.connection_id !== event.connectionId || +new Date(row.expires_at) <= Date.now() || appId && row.app_id !== appId) fail('WALLET_LOGIN_REQUIRED')
    await current(event)
    if (+new Date(row.expires_at) <= Date.now()) fail('WALLET_LOGIN_REQUIRED')
    return { playerId: event.playerId, privySubject: row.privy_subject, connectionId: row.connection_id, expiresAt: new Date(row.expires_at).toISOString(), appId: row.app_id }
  }
  return { challenge, complete, requireSession }
}
