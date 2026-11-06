import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const root = resolve(new URL('../..', import.meta.url).pathname)
const mineflayer = createRequire(new URL('../compatibility/package.json', import.meta.url))('mineflayer')

async function poll(read, accept, label, milliseconds = 30000) {
  const end = Date.now() + milliseconds
  do {
    const value = await read()
    if (accept(value)) return value
    await delay(200)
  } while (Date.now() < end)
  throw Error('LAPTOP_NATIVE_TIMEOUT_' + label)
}

export async function createLaptopNativeActors({ rootDirectory = root, sellerPlay = false } = {}) {
  const active = JSON.parse(await readFile(join(rootDirectory, '.local/playable-world/active.json'), 'utf8'))
  assert.equal(active.owner, 'agentcity-playable-pilot')
  assert.equal(active.deploymentOwner, 'agentcity-laptop-bank')
  const token = (await readFile(join(active.runtime, 'api-token'), 'utf8')).trim()
  const roster = JSON.parse(await readFile(join(active.runtime, 'laptop-fixture-actors.json'), 'utf8'))
  assert.equal(roster.schema, 'agentcity.laptop-bank-actors.v1')
  let previous
  try { previous = JSON.parse(await readFile(join(rootDirectory, '.local/playable-world/native-actors.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous) assert.equal(previous.serverId, active.serverId)
  const clients = []
  async function native(path, body) {
    const response = await fetch('http://127.0.0.1:25597/playable/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
    })
    const value = await response.json()
    if (!response.ok) throw Error(value.reason || value.code || 'LAPTOP_NATIVE_REFUSED')
    return value
  }
  try {
    const status = await native('property/status', {})
    assert.equal(status.serverNamespace, active.serverId)
    for (const actor of roster.actors) {
      await delay(4500)
      await native('discord/reserve', { playerName: actor.name, principalId: actor.principalId, discordId: actor.discordId,
        accountKind: 'local', expiresAtMs: Date.now() + 86400000 })
      const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25596, username: actor.name, auth: 'offline',
        version: '1.21.11', hideErrors: true, checkTimeoutInterval: 120000 })
      clients.push(bot)
      bot.on('error', () => {})
      bot.on('physicsTick', () => { if (bot._client.state === 'play') bot._client.write('tick_end', {}) })
      let timer
      try {
        await Promise.race([once(bot, 'spawn'), once(bot, 'kicked').then(([reason]) => { throw Error('LAPTOP_ACTOR_KICKED_' + JSON.stringify(reason)) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('LAPTOP_ACTOR_SPAWN_TIMEOUT')), 45000) })])
      } finally { clearTimeout(timer) }
      const playerId = bot._client.uuid
      const session = await poll(() => native('session?playerId=' + playerId), value => value.online && value.connectionId, 'SESSION')
      await native('discord/approve', { playerId, connectionId: session.connectionId, principalId: actor.principalId })
      await poll(() => native('session?playerId=' + playerId), value => value.pendingAuthentication === false && value.principalId === actor.principalId, 'APPROVAL')
      actor.minecraftPlayerId = playerId
      actor.connectionId = session.connectionId
      actor.bot = bot
      bot.setQuickBarSlot(8)
      if (sellerPlay && actor.name === 'BankSeller') {
        bot.chat('/play')
        await poll(() => native('session?playerId=' + playerId),
          value => value.serverPosition?.world === 'agentcity_play', 'SELLER_PLAY')
      }
    }
    const actors = roster.actors
    const observations = []
    for (const actor of actors.filter(value => value.name !== 'BankBidder')) {
      const old = previous?.observations.find(value => value.name === actor.name)
      if (old) {
        observations.push({ ...old, inventoryState: 'Historical preview only. Current custody and inventory must be reconciled with retained bank receipts.' })
        continue
      }
      await poll(() => actor.bot.inventory.items(), items => items.some(item => item.name === 'diamond_sword'), 'SWORD')
      const preview = await native('escrow/preview', { operationId: randomUUID(), sellerId: actor.principalId,
        sellerAccountId: actor.minecraftPlayerId, ownerPlayerId: actor.minecraftPlayerId, sourceId: actor.minecraftPlayerId,
        sourceKind: 'player_inventory', connectionId: actor.connectionId, slot: 8, count: 1 })
      assert.equal(preview.item, 'minecraft:diamond_sword')
      assert.equal(preview.descriptor.damage, 7)
      assert.equal(preview.descriptor.enchantments['minecraft:sharpness'], 2)
      observations.push({ name: actor.name, principalId: actor.principalId, minecraftPlayerId: actor.minecraftPlayerId,
        fingerprint: preview.fingerprint, fingerprintAlgorithm: preview.fingerprintAlgorithm || 'legacy_raw_sha256', descriptor: preview.descriptor, worldName: preview.worldName, worldUUID: preview.worldUUID })
    }
    const safeActors = actors.map(({ bot, ...value }) => value)
    await writeFile(join(rootDirectory, '.local/playable-world/bank-actors.json'), JSON.stringify({
      schema: 'agentcity.laptop-bank-actors.v1', serverId: active.serverId, fixture: true, nativeSessionsVerified: true,
      actors: Object.fromEntries(safeActors.map(value => [value.name.slice(4).toLowerCase(), value]))
    }, null, 2) + '\n', { mode: 0o600 })
    const result = { schema: 'agentcity.laptop-bank-native.v1', status: 'pass', recordedAt: new Date().toISOString(),
      serverId: active.serverId, container: active.container, actors: safeActors, observations,
      scope: 'Actual native controlled players and fixture equipment preview only. No human, Privy, loan or on-chain custody qualification.',
      sourceHashes: Object.fromEntries(await Promise.all(['tests/bank/native-laptop.mjs', 'tests/bank/LaptopBankStock.java'].map(async file =>
        [file, createHash('sha256').update(await readFile(join(rootDirectory, file))).digest('hex')]))), paidModelCalls: 0, publicTransactions: 0 }
    const output = join(rootDirectory, '.local/playable-world/native-actors.json')
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    return { active, actors, native, report: result, async close() { for (const bot of clients) bot.quit(); await delay(300) } }
  } catch (error) {
    for (const bot of clients) bot.quit()
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let context
  try {
    context = await createLaptopNativeActors({ sellerPlay: process.argv.includes('--seller-play') })
    const directory = join(root, 'evidence/runs/laptop-bank-native', randomUUID())
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'report.json'), JSON.stringify(context.report, null, 2) + '\n')
    console.log(JSON.stringify({ status: 'pass', actors: context.actors.map(value => value.name), serverId: context.active.serverId,
      evidence: join(directory, 'report.json'), scope: context.report.scope }))
    if (process.argv.includes('--serve')) {
      await Promise.race([
        new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) }),
        ...context.actors.map(actor => once(actor.bot, 'end').then(() => { throw Error('LAPTOP_NATIVE_ACTOR_DISCONNECTED_' + actor.name) }))
      ])
    }
  } catch (error) {
    const failure = { status: 'fail', error: error.message, recordedAt: new Date().toISOString(), scope: 'Laptop native fixture readiness; no chain transactions' }
    const directory = join(root, 'evidence/runs/laptop-bank-native', randomUUID())
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'report.json'), JSON.stringify(failure, null, 2) + '\n')
    console.error(JSON.stringify({ ...failure, evidence: join(directory, 'report.json') }))
    process.exitCode = 1
  } finally { await context?.close() }
}
