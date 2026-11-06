import { randomBytes, randomUUID } from 'node:crypto'
import { getAddress, hashTypedData, keccak256, stringToHex, verifyTypedData } from 'viem'

const CHALLENGE_LIFETIME_MS = 300000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPES = {
  WalletLink: [
    { name: 'serverId', type: 'string' },
    { name: 'playerUuid', type: 'string' },
    { name: 'sessionId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'origin', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAtMs', type: 'uint64' },
    { name: 'expiresAtMs', type: 'uint64' }
  ]
}

function refuse(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function text(value, maximum) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > maximum) refuse('INVALID_IDENTITY_FIELD')
  return value
}

function playerUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) refuse('INVALID_PLAYER_UUID')
  return value.toLowerCase()
}

function walletAddress(value) {
  try { return getAddress(value).toLowerCase() } catch { refuse('INVALID_WALLET') }
}

function fromRow(row) {
  return {
    id: row.id, serverId: row.server_id, playerUuid: row.player_uuid,
    sessionId: row.session_id, wallet: row.wallet, origin: row.origin,
    chainId: Number(row.chain_id), nonce: row.nonce,
    issuedAtMs: Number(row.issued_at_ms), expiresAtMs: Number(row.expires_at_ms),
    consumedAtMs: row.consumed_at_ms === null ? null : Number(row.consumed_at_ms)
  }
}

export function walletLinkTypedData(challenge) {
  return {
    domain: {
      name: 'AgentCity Identity', version: '1', chainId: challenge.chainId,
      salt: keccak256(stringToHex(JSON.stringify([challenge.origin, challenge.serverId])))
    },
    types: TYPES,
    primaryType: 'WalletLink',
    message: Object.fromEntries(TYPES.WalletLink.map(({ name }) => [name, challenge[name]]))
  }
}

export function createIdentityService({ store, context, resolveSession, clock = Date.now }) {
  if (!store?.transaction || typeof resolveSession !== 'function') refuse('DURABLE_STORE_AND_SESSION_AUTHORITY_REQUIRED')
  const serverId = text(context.serverId, 64)
  const origin = new URL(context.origin).origin
  const chainId = context.chainId
  if (!Number.isSafeInteger(chainId) || chainId < 1) refuse('INVALID_CHAIN')

  function now() {
    const value = clock()
    if (!Number.isSafeInteger(value) || value < 0) refuse('INVALID_AUTHORITY_CLOCK')
    return value
  }

  async function requireSession(binding, tx) {
    // resolveSession is trusted game authority, never a browser-supplied authenticated flag.
    const live = await resolveSession(binding, { transaction: tx })
    if (!live || live.serverId !== serverId || live.playerUuid?.toLowerCase() !== binding.playerUuid ||
        live.sessionId !== binding.sessionId || !Number.isSafeInteger(live.expiresAtMs) || now() >= live.expiresAtMs) refuse('LIVE_GAME_SESSION_REQUIRED')
  }

  async function issueChallenge({ playerUuid: player, sessionId, wallet }) {
    const binding = { serverId, playerUuid: playerUuid(player), sessionId: text(sessionId, 128) }
    const challenge = {
      ...binding, id: randomUUID(), wallet: walletAddress(wallet), origin, chainId,
      nonce: '0x' + randomBytes(32).toString('hex'), issuedAtMs: now()
    }
    challenge.expiresAtMs = challenge.issuedAtMs + CHALLENGE_LIFETIME_MS
    await store.transaction(async tx => {
      await requireSession(binding, tx)
      await tx.query(`INSERT INTO identity_challenges
        (id, server_id, player_uuid, session_id, wallet, origin, chain_id, nonce, issued_at_ms, expires_at_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [challenge.id, serverId, challenge.playerUuid, challenge.sessionId, challenge.wallet, origin, chainId, challenge.nonce, challenge.issuedAtMs, challenge.expiresAtMs])
    })
    return { ...challenge, typedData: walletLinkTypedData(challenge), digest: hashTypedData(walletLinkTypedData(challenge)) }
  }

  async function linkWallet({ challengeId, playerUuid: player, sessionId, wallet, signature }) {
    if (typeof challengeId !== 'string' || !UUID.test(challengeId)) refuse('INVALID_CHALLENGE_ID')
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) refuse('UNSUPPORTED_SIGNATURE')
    const expected = { playerUuid: playerUuid(player), sessionId: text(sessionId, 128), wallet: walletAddress(wallet) }
    try {
      return await store.transaction(async tx => {
        const { rows } = await tx.query('SELECT * FROM identity_challenges WHERE id=$1 FOR UPDATE', [challengeId])
        if (!rows.length) refuse('CHALLENGE_NOT_FOUND')
        const challenge = fromRow(rows[0])
        if (challenge.consumedAtMs !== null) refuse('CHALLENGE_ALREADY_CONSUMED')
        if (challenge.serverId !== serverId || challenge.origin !== origin || challenge.chainId !== chainId ||
            challenge.playerUuid !== expected.playerUuid || challenge.sessionId !== expected.sessionId || challenge.wallet !== expected.wallet) refuse('CHALLENGE_CONTEXT_MISMATCH')
        if (now() >= challenge.expiresAtMs) refuse('CHALLENGE_EXPIRED')
        if (!await verifyTypedData({ ...walletLinkTypedData(challenge), address: challenge.wallet, signature })) refuse('INVALID_WALLET_SIGNATURE')
        await requireSession({ serverId, playerUuid: expected.playerUuid, sessionId: expected.sessionId }, tx)
        if (now() >= challenge.expiresAtMs) refuse('CHALLENGE_EXPIRED')
        const linked = await tx.query('SELECT * FROM identity_links WHERE server_id=$1 AND (player_uuid=$2 OR wallet=$3) FOR UPDATE', [serverId, expected.playerUuid, expected.wallet])
        for (const row of linked.rows) {
          if (row.player_uuid !== expected.playerUuid) refuse('WALLET_ALREADY_LINKED')
          if (row.wallet !== expected.wallet) refuse('RELINK_REQUIRES_BOTH_WALLETS')
        }
        const consumedAtMs = now()
        await tx.query('UPDATE identity_challenges SET consumed_at_ms=$2 WHERE id=$1', [challenge.id, consumedAtMs])
        await tx.query(`INSERT INTO identity_links(server_id,player_uuid,wallet,session_id,challenge_id,linked_at_ms)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(server_id,player_uuid) DO UPDATE
          SET session_id=EXCLUDED.session_id,challenge_id=EXCLUDED.challenge_id,linked_at_ms=EXCLUDED.linked_at_ms`,
        [serverId, expected.playerUuid, expected.wallet, expected.sessionId, challenge.id, consumedAtMs])
        return { serverId, ...expected, challengeId: challenge.id, linkedAtMs: consumedAtMs }
      })
    } catch (error) {
      if (error.code === '23505') refuse('IDENTITY_CONFLICT')
      throw error
    }
  }

  async function getLink(player) {
    const { rows } = await store.query('SELECT * FROM identity_links WHERE server_id=$1 AND player_uuid=$2', [serverId, playerUuid(player)])
    return rows[0] ? { serverId, playerUuid: rows[0].player_uuid, wallet: rows[0].wallet, sessionId: rows[0].session_id } : null
  }

  return { issueChallenge, linkWallet, getLink }
}
