// Real isolated Anvil + PostgreSQL assembly; native inventory/identity/wallet
// adapters are explicit fixtures. Never a public-chain, Privy or Minecraft proof.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWorldAssets } from '../../backend/src/world-assets/service.mjs'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { createPublicClient, createWalletClient, createTestClient, http, keccak256, stringToHex, parseEther } = require('viem')
const { foundry } = require('viem/chains'), { Pool } = require('pg')
const root = fileURLToPath(new URL('../../', import.meta.url)), runId = randomUUID(), schema = 'world_asset_e2e_' + runId.replaceAll('-', '')
const directory = join(root, 'evidence/runs/world-assets-service', runId)
await mkdir(directory, { recursive: true })
const report = { runId, status: 'fail', scope: 'Actual isolated Anvil31337 + PostgreSQL; injected native/identity/unlocked-local-wallet fixtures. No public transactions, actual equipment, human identities or live Privy signing.', checks: [], publicTransactions: 0, actualMinecraftWrites: 0 }
report.sourceHashes = {}
for (const name of ['service.mjs', 'canonical.mjs', 'store.mjs', 'managed-policy.mjs', 'abis.mjs']) report.sourceHashes[name] = createHash('sha256').update(await readFile(join(root, 'backend/src/world-assets', name))).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pass = name => { report.checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
let child, pool, admin, created = false
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
  const ownerA = { principalId: '11111111-1111-4111-8111-111111111111', minecraftPlayerId: '22222222-2222-4222-8222-222222222222', privySubject: 'did:privy:fixture-a', walletAddress: accounts[2].toLowerCase() }
  const ownerB = { principalId: '33333333-3333-4333-8333-333333333333', minecraftPlayerId: '44444444-4444-4444-8444-444444444444', privySubject: 'did:privy:fixture-b', walletAddress: accounts[3].toLowerCase() }
  const owners = [ownerA, ownerB], signed = new Map()
  function signer(address, player = false) { return { address,
    async prepare(input) { assert(Number.isSafeInteger(input.limits.maxGas)); assert(input.limits.maxGas >= 21000 && input.limits.maxGas <= 1000000); assert(BigInt(input.limits.maxNativeCostWei) <= 8000000000000000n); const expected = player ? owners.find(value => value.principalId === input.playerId)?.walletAddress : address; assert(expected); const body = { address: expected, to: input.to, data: input.data, value: String(input.value) }; if (signed.has(input.operationId)) assert.deepEqual(signed.get(input.operationId).body, body); else signed.set(input.operationId, { body }) },
    async broadcast({ operationId }) { const row = signed.get(operationId); if (!row.hash) { const current = await client.getBlock(); await delay(Math.max(0, (Number(current.timestamp) + 1) * 1000 - Date.now())); row.hash = await wallet.sendTransaction({ account: row.body.address, to: row.body.to, data: row.body.data, value: 0n, gas: 2000000n }); await receipt(row.hash); await miner.mine({ blocks: 1, interval: 0 }) } return { transactionHash: row.hash } },
    async reconcile({ operationId }) { return { status: 'confirmed', transactionHash: signed.get(operationId).hash } }
  } }
  const equipmentFingerprint = 'a'.repeat(64), houseFingerprint = 'b'.repeat(64), catalogDigest = 'c'.repeat(64)
  const catalog = [1, 2, 3, 4].map(parcelId => { const x = (parcelId - 1) % 2 * 32, z = Math.floor((parcelId - 1) / 2) * 32; return { parcelId, world: 'agentcity_estates', cellX: x / 16, cellZ: z / 16, catalogDigest, bounds: { min: [x, -64, z], max: [x + 15, 319, z + 15] } } })
  const operations = new Map(), freezes = new Map(), nativeCalls = [], projection = { parcels: [], invalidated: false }
  let reservations = 0, releases = 0, houseChanged = false, loseFreezeReply = true, approved = false
  const native = async (path, body) => {
    nativeCalls.push({ path, body: structuredClone(body) })
    if (path.startsWith('session?')) { const value = owners.find(owner => path.endsWith(owner.minecraftPlayerId)); return { online: true, pendingAuthentication: false, principalId: value.principalId, connectionId: '55555555-5555-4555-8555-555555555555', authenticationKind: 'discord_approved_local_profile' } }
    if (path === 'escrow/preview') return { previewId: body.operationId, sourceId: body.sourceId, worldName: 'agentcity_play', worldUUID: '66666666-6666-4666-8666-666666666666', selectionSlot: 0, item: 'minecraft:diamond_sword', count: 1, fingerprint: equipmentFingerprint, descriptor: { material: 'diamond_sword', damage: 7, enchantments: { sharpness: 2 }, name: 'Exact fixture sword' }, expiresAtMs: Date.now() + 300000 }
    if (path === 'escrow/status') return operations.has(body.operationId) ? { known: true, pending: false, receipt: operations.get(body.operationId) } : { known: false }
    if (path === 'escrow/authorize') return { authorized: true }
    if (path === 'escrow/reserve') { if (!operations.has(body.operationId)) { reservations++; operations.set(body.operationId, { ...body, escrowed: true, custodyId: body.listingId, fingerprint: equipmentFingerprint }) } return operations.get(body.operationId) }
    if (['escrow/asset-configure', 'property/configure'].includes(path)) { assert.match(body.operationId, /^[a-f0-9-]{36}$/); return { configured: true } }
    if (path === 'escrow/asset-bind') { assert(body.confirmations >= 2); assert(Number.isSafeInteger(body.blockNumber)); return { bound: true, ...body } }
    if (path === 'escrow/asset-release') { if (!operations.has(body.operationId)) { const backed = [...operations.values()].find(value => value.listingId === body.listingId && value.escrowed); releases++; operations.set(body.operationId, { ...body, assigned: true, ownerId: body.ownerId, item: backed.item, count: backed.count }) } return operations.get(body.operationId) }
    if (path === 'property/status') return { catalog }
    if (path === 'property/preview') return { parcel: catalog.find(parcel => parcel.parcelId === body.parcelId), houseSnapshotFingerprint: houseFingerprint, expiresAtMs: Date.now() + 300000 }
    if (path === 'property/freeze') {
      assert.equal(body.expectedFingerprint, houseFingerprint); if (houseChanged) throw Error('Native house changed; publish a new snapshot first.')
      assert.equal(projection.parcels.find(value => value.parcelId === body.parcelId)?.ownerPrincipalId, body.ownerPrincipalId)
      if (freezes.has(body.operationId)) assert.deepEqual(freezes.get(body.operationId), body); else freezes.set(body.operationId, body)
      if (loseFreezeReply) { loseFreezeReply = false; throw Error('Fixture lost already-durable native freeze reply') }
      return { frozen: true, ...body }
    }
    if (path === 'property/apply') { assert(Number.isSafeInteger(body.blockNumber)); assert(body.confirmations >= 2); assert.equal(body.parcels.length, 4); projection.parcels = structuredClone(body.parcels); projection.invalidated = false; return { applied: true, revision: body.revision } }
    if (path === 'property/invalidate') { projection.invalidated = true; projection.parcels = []; return { invalidated: true } }
    throw Error('Unimplemented native fixture route ' + path)
  }
  const service = await createWorldAssets({ pool, manifest, client, wallets: signer(null, true), registrar: signer(accounts[1]), native, allowLocalFixture: true,
    resolveIdentity: async ({ principalId }) => owners.find(value => value.principalId === principalId), resolveWalletOwner: async ({ walletAddress }) => owners.find(value => value.walletAddress === walletAddress),
    authorize: async input => approved ? { approved: true, principalId: input.principalId, termsDigest: input.termsDigest } : false })
  const preview = await service.previewMint({ principalId: ownerA.principalId, operationId: 'equipment-fixture', kind: 'item', sourceKind: 'player_inventory' })
  await assert.rejects(service.confirmMint({ principalId: ownerA.principalId, previewId: preview.previewId, termsDigest: preview.termsDigest, confirmationId: 'no-consent' }), /REQUESTER_APPROVAL/)
  assert.equal(reservations, 0); approved = true
  const minted = await service.confirmMint({ principalId: ownerA.principalId, previewId: preview.previewId, termsDigest: preview.termsDigest, confirmationId: 'explicit-fixture-consent' })
  assert.equal(minted.status, 'complete'); assert.equal(reservations, 1); assert(minted.proofs.every(proof => proof.confirmations >= 2 && proof.logHash))
  await service.confirmMint({ principalId: ownerA.principalId, previewId: preview.previewId, termsDigest: preview.termsDigest, confirmationId: 'retry' }); assert.equal(reservations, 1)
  await assert.rejects(service.status({ principalId: ownerB.principalId, operationId: preview.previewId }), /REQUEST_OWNER/)
  pass('Actual EVM equipment mint binds exact native fixture backing once, waits canonical2conf, preserves replay and refuses missing consent/foreign preview owner')

  const land = await service.previewMint({ principalId: ownerA.principalId, operationId: 'parcel-fixture', kind: 'parcel', parcelId: 1 })
  const parcel = await service.confirmMint({ principalId: ownerA.principalId, previewId: land.previewId, termsDigest: land.termsDigest, confirmationId: 'parcel-consent' })
  assert.equal(parcel.status, 'complete'); assert.equal((await service.sync()).status, 'active'); assert.equal(projection.parcels[0].ownerPlayerId, ownerA.minecraftPlayerId)
  const offer = await service.previewList({ principalId: ownerA.principalId, operationId: 'house-sale', tokenId: parcel.tokenId, priceBaseUnits: parseEther('3').toString(), expiry: Math.floor(Date.now() / 1000) + 3600 })
  const beforeFreeze = signed.size
  houseChanged = true
  await assert.rejects(service.confirmList({ principalId: ownerA.principalId, previewId: offer.previewId, termsDigest: offer.termsDigest, confirmationId: 'changed-house-refused' }), /Native house changed/)
  assert.equal(signed.size, beforeFreeze); assert.equal(freezes.size, 0); houseChanged = false
  await assert.rejects(service.confirmList({ principalId: ownerA.principalId, previewId: offer.previewId, termsDigest: offer.termsDigest, confirmationId: 'offer-consent' }), /lost already-durable/)
  assert.equal(signed.size, beforeFreeze); assert.equal(freezes.size, 1)
  const listed = await service.confirmList({ principalId: ownerA.principalId, previewId: offer.previewId, termsDigest: offer.termsDigest, confirmationId: 'offer-resume' })
  assert.equal(listed.status, 'complete'); assert.equal(freezes.size, 1)
  pass('Actual parcel NFT projection binds registered MC identity and exact house snapshot; lost native pre-sale lock reply resumes the same freeze before any listing transaction')

  const checkpoint = await miner.snapshot()
  const quote = await service.previewBuy({ principalId: ownerB.principalId, operationId: 'buy-house', tokenId: parcel.tokenId })
  const bought = await service.confirmBuy({ principalId: ownerB.principalId, previewId: quote.previewId, termsDigest: quote.termsDigest, confirmationId: 'buy-consent' })
  assert.equal(bought.status, 'complete')
  await service.sync(); assert.equal(projection.parcels[0].ownerPrincipalId, ownerB.principalId); assert.equal(projection.parcels[0].marketResolution, 'confirmed_purchase')
  assert.equal(await client.readContract({ address: city, abi: artifacts.City.abi, functionName: 'balanceOf', args: [accounts[2]] }), parseEther('3'))
  assert.equal((await service.ownedAssets({ principalId: ownerB.principalId })).assets[0].owner, ownerB.walletAddress)
  const feed = await service.receipts({ limit: 10 })
  assert(feed.some(value => value.eventName === 'AssetPurchased' && value.tokenId === parcel.tokenId))
  assert(feed.every(value => !('principalId' in value) && !('terms' in value) && !('privySubject' in value) && value.confirmations >= 2))
  await miner.revert({ id: checkpoint })
  assert.equal((await service.sync()).status, 'paused'); assert.equal(projection.invalidated, true); assert.equal(projection.parcels.length, 0)
  pass('Actual CITY/NFT atomic house purchase updates canonical owner projection; real Anvil reorganization invalidates native fixture rights instead of granting from stale ownership')

  const redemption = await service.previewRedeem({ principalId: ownerA.principalId, operationId: 'redeem-sword', tokenId: minted.tokenId })
  const redeemed = await service.confirmRedeem({ principalId: ownerA.principalId, previewId: redemption.previewId, termsDigest: redemption.termsDigest, confirmationId: 'redeem-consent' })
  assert.equal(redeemed.status, 'complete'); assert.equal(releases, 1)
  await service.confirmRedeem({ principalId: ownerA.principalId, previewId: redemption.previewId, termsDigest: redemption.termsDigest, confirmationId: 'redeem-retry' }); assert.equal(releases, 1)
  const asset = await client.readContract({ address: registry, abi: artifacts.WorldAssetRegistry.abi, functionName: 'asset', args: [BigInt(minted.tokenId)] })
  assert.equal(asset.redeemed, true); assert.equal(asset.redemptionPending, false)
  assert(nativeCalls.findIndex(value => value.path === 'escrow/asset-release') > nativeCalls.findIndex(value => value.path === 'escrow/asset-bind'))
  pass('Actual irreversible canonical item redemption lock precedes exact native fixture mailbox assignment and registrar burn; replay never releases backing twice')
  report.status = 'pass'; report.localTransactions = signed.size; report.nativeFixtureReservations = reservations; report.nativeFixtureReleases = releases
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await pool?.end()
  if (created) { assert(/^world_asset_e2e_[a-f0-9]{32}$/.test(schema)); await admin.query('DROP SCHEMA ' + schema + ' CASCADE') }
  await admin?.end()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  report.finishedAt = new Date().toISOString()
  for (const [name, original] of Object.entries(report.sourceHashes)) if (original !== createHash('sha256').update(await readFile(join(root, 'backend/src/world-assets', name))).digest('hex')) { report.status = 'fail'; report.error = 'Source changed during the fixture run: ' + name; process.exitCode = 1 }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, report: join(directory, 'report.json'), checks: report.checks.length, error: report.error?.split('\n')[0] }))
}
