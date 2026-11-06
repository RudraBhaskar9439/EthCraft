// Actual isolated Paper + Anvil + PostgreSQL translation seam.
// Identity and unlocked local-wallet authorization are explicit fixtures, not live Privy users.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWorldAssets } from '../../backend/src/world-assets/service.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, createWalletClient, createTestClient, http, keccak256, stringToHex, parseEther } = require('viem')
const { foundry } = require('viem/chains'), { Pool } = require('pg')
const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID(), schema = 'world_asset_resource_' + runId.replaceAll('-', '')
const directory = join(root, 'evidence/runs/world-assets-resource', runId)
await mkdir(directory, { recursive: true })
const report = { runId, status: 'fail', scope: 'Actual isolated Paper26.3 resource-lot escrow/claim + Anvil31337 contracts + PostgreSQL translation service. Synthetic Discord/Privy principals and unlocked local signers; no real human, live Privy, public-chain or production action.', checks: [], publicTransactions: 0, productionMinecraftWrites: 0 }
report.sourceHashes = {}
for (const name of ['service.mjs', 'canonical.mjs', 'store.mjs', 'managed-policy.mjs', 'abis.mjs']) report.sourceHashes[name] = createHash('sha256').update(await readFile(join(root, 'backend/src/world-assets', name))).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pass = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
let child, pool, admin, created = false
const bots = []
try {
  assert.equal(process.platform, 'linux', 'Run with the owned WSL Node executable so the exact child PID can be verified and stopped.')
  const probe = createServer(); probe.listen(18559, '127.0.0.1'); await once(probe, 'listening'); await new Promise(resolve => probe.close(resolve))
  const executable = join(root, '.local/tools/foundry-linux/anvil')
  child = spawn(executable, ['--host', '127.0.0.1', '--port', '18559', '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'ignore'] })
  const transport = http('http://127.0.0.1:18559', { retryCount: 0, timeout: 3000 })
  const client = createPublicClient({ chain: foundry, transport }), miner = createTestClient({ chain: foundry, mode: 'anvil', transport })
  for (let attempt = 0; ; attempt++) { try { assert.equal(await client.getChainId(), 31337); break } catch (error) { if (attempt >= 30 || child.exitCode !== null) throw error; await delay(100) } }
  const listener = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }).split('\n').find(line => line.includes('127.0.0.1:18559'))
  assert(listener?.includes('pid=' + child.pid + ',')); report.ownedAnvil = { pid: child.pid, address: '127.0.0.1:18559', chainId: 31337 }
  const accounts = await client.request({ method: 'eth_accounts' }), wallet = createWalletClient({ chain: foundry, transport })
  const artifacts = {}
  for (const name of ['WorldAssetRegistry', 'WorldAssetMarket']) artifacts[name] = JSON.parse(await readFile(join(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'))
  artifacts.City = JSON.parse(await readFile(join(root, 'contracts/out/WorldAssets.t.sol/WorldAssetCityFixture.json'), 'utf8'))
  const receipt = hash => client.waitForTransactionReceipt({ hash })
  async function deploy(artifact, args = []) { const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, account: accounts[0] }); return (await receipt(hash)).contractAddress.toLowerCase() }
  const city = await deploy(artifacts.City), registry = await deploy(artifacts.WorldAssetRegistry, [accounts[0], accounts[1]]), market = await deploy(artifacts.WorldAssetMarket, [registry, city])
  await receipt(await wallet.writeContract({ account: accounts[0], address: city, abi: artifacts.City.abi, functionName: 'mint', args: [accounts[3], parseEther('100')] }))
  await miner.mine({ blocks: 1, interval: 0 })
  const manifest = { schema: 'agentcity.world-assets.v1', environment: 'LOCAL_TEST_FIXTURE', chainId: 31337, rpcUrl: 'http://127.0.0.1:18559',
    genesisHash: (await client.getBlock({ blockNumber: 0n })).hash, serverId: keccak256(stringToHex('isolated-native-fixture')), deploymentId: keccak256(stringToHex(runId)),
    registry, market, city, codeHashes: {}, confirmations: 2, maxPriceBaseUnits: parseEther('100').toString(), maxGas: '1000000', maxNativeCostWei: '8000000000000000' }
  for (const name of ['registry', 'market', 'city']) manifest.codeHashes[name] = keccak256(await client.getCode({ address: manifest[name] }))
  report.manifest = manifest
  const environment = JSON.parse(await readFile(join(root, '.local/backend/environment.json'), 'utf8'))
  const db = new URL(environment.databaseUrl); assert(['127.0.0.1', 'localhost'].includes(db.hostname))
  admin = new Pool({ connectionString: environment.databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
  await admin.query('CREATE SCHEMA ' + schema); created = true
  pool = new Pool({ connectionString: environment.databaseUrl, options: '-c search_path=' + schema, max: 1, connectionTimeoutMillis: 5000 })
  assert.equal(process.argv.length, 3, 'Pass the fresh owned Paper fixture config path.')
  const path = await realpath(process.argv[2])
  assert(path.startsWith(join(root, '.local/world-assets-seam') + '/'))
  const fixture = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(fixture.owner, 'world-assets-seam-fixture')
  assert.equal(fixture.minecraft.port, 25606); assert.equal(fixture.apiOrigin, 'http://127.0.0.1:25607')
  const token = (await readFile(fixture.apiTokenFile, 'utf8')).trim()
  assert(typeof token === 'string' && token.length >= 32)
  const windowsPath = value => /^[A-Za-z]:[\\/]/.test(value) ? '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replaceAll('\\', '/') : value
  const fixtureRuntime = windowsPath(fixture.runtime || fixture.fixtureRuntime)
  assert(fixtureRuntime.startsWith(join(root, '.local/') ))
  const jarHash = createHash('sha256').update(await readFile(join(fixtureRuntime, 'plugins/AgentCity.jar'))).digest('hex')
  assert.equal(jarHash, fixture.pluginSha256)
  assert.equal(fixture.fixtureGrant.item, 'minecraft:stick'); assert.equal(fixture.fixtureGrant.count, 3)
  report.paper = { owner: fixture.owner, container: fixture.container, runtime: fixtureRuntime, pluginSha256: jarHash, gamePort: 25606, apiPort: 25607,
    stock: 'Exactly three declared plain sticks in the fixture source slot; reserve one and retain two. No other stock introduced by this test.',
    infrastructureDisclosure: fixture.infrastructure, fixtureGrant: fixture.fixtureGrant, dependencies: fixture.dependencies }
  const nativeCalls = []
  const native = async (path, body) => {
    nativeCalls.push({ path, operationId: body?.operationId || null })
    const response = await fetch('http://127.0.0.1:25607/playable/' + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
    const value = await response.json(); if (!response.ok) throw Error(value.reason || value.code || 'REAL_NATIVE_API_REFUSED')
    return value
  }
  const mineflayer = createRequire(new URL('../compatibility/package.json', import.meta.url))('mineflayer')
  async function poll(read, accept, label, ms = 20000) {
    const end = Date.now() + ms
    do { const value = await read(); if (accept(value)) return value; await delay(150) } while (Date.now() < end)
    throw Error('TIMEOUT ' + label)
  }
  async function player(name, principalId, discordId) {
    await native('discord/reserve', { playerName: name, principalId, discordId, accountKind: 'local', expiresAtMs: Date.now() + 3600000 })
    await delay(4500)
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25606, username: name, auth: 'offline', version: '1.21.11', hideErrors: true })
    bots.push(bot); bot.on('error', () => {})
    bot.on('physicsTick', () => { if (bot._client.state === 'play') bot._client.write('tick_end', {}) })
    let timeout
    try { await Promise.race([once(bot, 'spawn'), once(bot, 'kicked').then(([reason]) => { throw Error('Fixture player rejected: ' + JSON.stringify(reason)) }), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Fixture spawn timeout')), 45000) })]) }
    finally { clearTimeout(timeout) }
    const minecraftPlayerId = bot._client.uuid
    const active = await poll(() => native('session?playerId=' + minecraftPlayerId), value => value.online && value.connectionId, 'native current fixture session')
    await native('discord/approve', { playerId: minecraftPlayerId, connectionId: active.connectionId, principalId })
    await poll(() => native('session?playerId=' + minecraftPlayerId), value => value.pendingAuthentication === false && value.principalId === principalId, 'actual fixture approval')
    await delay(500)
    return { principalId, minecraftPlayerId, connectionId: active.connectionId, bot }
  }
  let priorAccess = { reservations: {} }
  try { priorAccess = JSON.parse(await readFile(join(fixtureRuntime, 'plugins/AgentCity/discord-game-access.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const principal = (name, discordId) => {
    const old = priorAccess.reservations?.[name.toLowerCase()]
    if (!old) return randomUUID()
    assert.equal(old.playerName, name); assert.equal(old.discordId, discordId); assert.equal(old.accountKind, 'local')
    return old.principalId
  }
  const a = await player('EscSeller', principal('EscSeller', '660000000000000011'), '660000000000000011')
  const b = await player('EscBuyer', principal('EscBuyer', '660000000000000012'), '660000000000000012')
  const stickCount = bot => bot.inventory.items().filter(item => item.name === 'stick').reduce((sum, item) => sum + item.count, 0)
  await poll(() => stickCount(a.bot), count => count === 3, 'declared actual fixture sticks')
  assert.equal(stickCount(b.bot), 0)
  const ownerA = { principalId: a.principalId, minecraftPlayerId: a.minecraftPlayerId, privySubject: 'did:privy:explicit-seam-fixture-a', walletAddress: accounts[2].toLowerCase() }
  const ownerB = { principalId: b.principalId, minecraftPlayerId: b.minecraftPlayerId, privySubject: 'did:privy:explicit-seam-fixture-b', walletAddress: accounts[3].toLowerCase() }
  const owners = [ownerA, ownerB], signed = new Map()
  // Anvil has no background block production while real clients join. Renew
  // its actual local chain clock; never weaken the production freshness check.
  const fixtureHead = await client.getBlock()
  await miner.setNextBlockTimestamp({ timestamp: BigInt(Math.max(Math.floor(Date.now() / 1000), Number(fixtureHead.timestamp) + 1)) })
  await miner.mine({ blocks: 2, interval: 0 })
  function signer(address, player = false) { return { address,
    async prepare(input) {
      assert(Number.isSafeInteger(input.limits.maxGas) && input.limits.maxGas <= 1000000)
      const expected = player ? owners.find(value => value.principalId === input.playerId)?.walletAddress : address
      assert(expected)
      const body = { address: expected, to: input.to, data: input.data, value: String(input.value), gas: input.limits.maxGas }
      if (signed.has(input.operationId)) assert.deepEqual(signed.get(input.operationId).body, body)
      else signed.set(input.operationId, { body })
    },
    async broadcast({ operationId }) {
      const row = signed.get(operationId)
      if (!row.hash) {
        const current = await client.getBlock(); await delay(Math.max(0, (Number(current.timestamp) + 1) * 1000 - Date.now()))
        row.hash = await wallet.sendTransaction({ account: row.body.address, to: row.body.to, data: row.body.data, value: 0n, gas: BigInt(row.body.gas) })
        await receipt(row.hash); await miner.mine({ blocks: 1, interval: 0 })
      }
      return { transactionHash: row.hash }
    },
    async reconcile({ operationId }) { return { status: 'confirmed', transactionHash: signed.get(operationId).hash } }
  } }
  const service = await createWorldAssets({ pool, manifest, client, wallets: signer(null, true), registrar: signer(accounts[1]), native, allowLocalFixture: true,
    resolveIdentity: async ({ principalId }) => owners.find(value => value.principalId === principalId),
    resolveWalletOwner: async ({ walletAddress }) => owners.find(value => value.walletAddress === walletAddress),
    authorize: async input => ({ approved: true, principalId: input.principalId, termsDigest: input.termsDigest, disclosure: 'Automated local fixture consent; not an actual Privy human' }) })
  const before = await service.previewMint({ principalId: a.principalId, operationId: 'real-paper-stick-' + runId, kind: 'item', sourceKind: 'player_inventory', selection: fixture.fixtureGrant.slot, count: 1 })
  const original = before.terms.nativePreview
  assert.equal(original.item, 'minecraft:stick'); assert.equal(original.count, 1); assert.equal(original.descriptor.amount, 1)
  report.originalResource = { fingerprint: original.fingerprint, descriptor: original.descriptor, worldName: original.worldName, worldUUID: original.worldUUID, selectionSlot: original.selectionSlot }
  const minted = await service.confirmMint({ principalId: a.principalId, previewId: before.previewId, termsDigest: before.termsDigest, confirmationId: 'explicit-seam-fixture-mint' })
  assert.equal(minted.status, 'complete'); await poll(() => stickCount(a.bot), count => count === 2, 'actual seller one-stick escrow remainder')
  report.mint = minted; pass('REAL Paper selected one-of-three stick portion preview/reserve→actual canonical Anvil NFT mint→REAL native token/custody binding')
  const listing = await service.previewList({ principalId: a.principalId, operationId: 'real-paper-stick-list-' + runId, tokenId: minted.tokenId, priceBaseUnits: parseEther('3').toString(), expiry: Math.floor(Date.now() / 1000) + 3600 })
  const listed = await service.confirmList({ principalId: a.principalId, previewId: listing.previewId, termsDigest: listing.termsDigest, confirmationId: 'explicit-seam-fixture-list' })
  assert.equal(listed.status, 'complete')
  const quote = await service.previewBuy({ principalId: b.principalId, operationId: 'real-paper-stick-buy-' + runId, tokenId: minted.tokenId })
  const bought = await service.confirmBuy({ principalId: b.principalId, previewId: quote.previewId, termsDigest: quote.termsDigest, confirmationId: 'explicit-seam-fixture-buy' })
  assert.equal(bought.status, 'complete')
  assert.equal((await service.ownedAssets({ principalId: b.principalId })).assets[0].owner, ownerB.walletAddress)
  assert.equal(await client.readContract({ address: city, abi: artifacts.City.abi, functionName: 'balanceOf', args: [accounts[2]] }), parseEther('3'))
  report.listing = listed; report.purchase = bought
  pass('Actual NFT listing and exact3CITY atomic purchase transfer canonical ownership to the second fixture principal while exact one-stick lot stays in native custody and seller keeps two')
  const request = await service.previewRedeem({ principalId: b.principalId, operationId: 'real-paper-stick-redeem-' + runId, tokenId: minted.tokenId })
  const redeemed = await service.confirmRedeem({ principalId: b.principalId, previewId: request.previewId, termsDigest: request.termsDigest, confirmationId: 'explicit-seam-fixture-redeem' })
  assert.equal(redeemed.status, 'complete')
  const asset = await client.readContract({ address: registry, abi: artifacts.WorldAssetRegistry.abi, functionName: 'asset', args: [BigInt(minted.tokenId)] })
  assert.equal(asset.redeemed, true)
  const mailbox = await native('escrow/mailbox', { ownerId: b.principalId })
  const entry = mailbox.entries.find(value => value.mailboxId === before.previewId)
  assert(entry); assert.equal(entry.fingerprint, original.fingerprint)
  const active = await native('session?playerId=' + b.minecraftPlayerId)
  const claim = { operationId: randomUUID(), mailboxId: entry.mailboxId, ownerId: b.principalId, playerId: b.minecraftPlayerId, connectionId: active.connectionId }
  const claimed = await native('escrow/claim', claim); assert.equal(claimed.claimed, true)
  await poll(() => stickCount(b.bot), count => count === 1, 'actual buyer one-stick delivery')
  const receivedItem = b.bot.inventory.items().find(item => item.name === 'stick'), nativeSlot = receivedItem.slot >= 36 ? receivedItem.slot - 36 : receivedItem.slot
  const finalPreview = await native('escrow/preview', { operationId: randomUUID(), sellerId: b.principalId, sellerAccountId: b.minecraftPlayerId, ownerPlayerId: b.minecraftPlayerId,
    sourceId: b.minecraftPlayerId, sourceKind: 'player_inventory', connectionId: active.connectionId, slot: nativeSlot, count: 1 })
  assert.equal(finalPreview.fingerprint, original.fingerprint); assert.deepEqual(finalPreview.descriptor, original.descriptor)
  const signedBeforeRetry = signed.size
  await service.confirmRedeem({ principalId: b.principalId, previewId: request.previewId, termsDigest: request.termsDigest, confirmationId: 'same-operation-retry' })
  await native('escrow/claim', claim)
  assert.equal(signed.size, signedBeforeRetry); assert.equal(stickCount(a.bot), 2); assert.equal(stickCount(b.bot), 1)
  assert.equal((await native('escrow/status', {})).pendingCount, 0)
  report.redemption = redeemed; report.claim = claimed; report.finalResource = { fingerprint: finalPreview.fingerprint, descriptor: finalPreview.descriptor }
  report.conservation = { declaredFixtureSticks: 3, reservedLotCount: 1, finalSeller: 2, finalBuyer: 1, repeatedClaimAdditionalItems: 0, sameOperationAdditionalTransactions: 0 }
  report.chainTransactions = [...signed].map(([operationId, value]) => ({ operationId, transactionHash: value.hash }))
  report.nativeCalls = nativeCalls; report.localTransactions = signed.size
  pass('Actual canonical redemption lock→REAL native asset-release mailbox→Anvil burn→REAL recipient claim preserves byte-exact one-stick resource lot with seller2/buyer1 conservation with zero extra items/transactions on retry')
  report.status = 'pass'
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  for (const bot of bots) { try { bot.quit('Isolated real-native/EVM fixture finished') } catch {} }
  await pool?.end()
  if (created && report.status === 'pass') { assert(/^world_asset_resource_[a-f0-9]{32}$/.test(schema)); await admin.query('DROP SCHEMA ' + schema + ' CASCADE') }
  else if (created) report.retainedSchema = schema
  await admin?.end()
  if (child && child.exitCode === null && report.status === 'pass') { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  else if (child && child.exitCode === null) { report.retainedAnvil = { pid: child.pid, address: '127.0.0.1:18559', reason: 'Failure preserves exact native/chain/SQL intents for inspection, never reset or replace.' }; child.unref() }
  report.finishedAt = new Date().toISOString()
  for (const [name, original] of Object.entries(report.sourceHashes)) if (original !== createHash('sha256').update(await readFile(join(root, 'backend/src/world-assets', name))).digest('hex')) { report.status = 'fail'; report.error = 'Source changed during the combined fixture: ' + name; process.exitCode = 1 }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, report: join(directory, 'report.json'), checks: report.checks.length, error: report.error?.split('\n')[0] }))
}
