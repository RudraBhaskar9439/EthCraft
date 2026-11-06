import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { openWalletHandoffs } from '../backend/src/identity/http-runtime.mjs'

const options = process.argv.slice(2)
const list = options.length === 1 && options[0] === '--list'
if (!list && (options.length !== 2 || options[0] !== '--player' || !/^[a-f0-9-]{36}$/i.test(options[1]))) throw new Error('usage: --list | --player AUTHENTICATED_PLAYER_UUID')
const origin = 'http://127.0.0.1:8789'
const runtime = await openWalletHandoffs(origin)
try {
  const sessions = await runtime.identity.listPairedSessions()
  if (list) console.log(JSON.stringify({ scope: 'Actual player-initiated pair requests from the owned direct online-mode probe', sessions }, null, 2))
  else {
    const session = sessions.find(entry => entry.playerUuid === options[1].toLowerCase())
    if (!session) throw new Error('live_player_initiated_wallet_pairing_required')
    const prepared = await runtime.service.prepareIdentity({ playerUuid: session.playerUuid, sessionId: session.sessionId, wallet: session.wallet })
    const directory = new URL('../.local/human-identities/' + randomUUID() + '/', import.meta.url)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const link = origin + '/wallet#' + prepared.urlFragment
    await writeFile(new URL('identity.json', directory), JSON.stringify({ playerUuid: session.playerUuid, wallet: session.wallet, url: link }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    const safe = link.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    await writeFile(new URL('identity.html', directory), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + safe + '"><title>Private identity approval</title><a href="' + safe + '">Review this session identity</a>', { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ status: 'prepared', playerUuid: session.playerUuid, wallet: session.wallet, privateDirectory: directory.pathname, signaturesCollected: 0, transactionsSubmitted: 0, economicBridge: false }))
  }
} finally { await runtime.close() }
