import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createGameEconomy } from '../../backend/src/playable/economy.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { Pool } = require('pg')
const settings = JSON.parse(await readFile(new URL('../../.local/backend/environment.json', import.meta.url), 'utf8'))
const schema = 'game_economy_test_' + randomUUID().replaceAll('-', '')
const administrator = new Pool({ connectionString: settings.databaseUrl, max: 1 })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c search_path=' + schema, max: 4 })
const checks = []
const check = name => { checks.push({ name, status: 'pass' }); console.log('PASS ' + name) }
const alice = { playerId: randomUUID(), playerName: 'EconomyAlice' }
const bob = { playerId: randomUUID(), playerName: 'EconomyBob' }
const outsider = { playerId: randomUUID(), playerName: 'EconomyOther' }
const event = (actor, action, args = []) => ({ ...actor, action, args, operationId: randomUUID(), createdAtMs: Date.now() })
const report = { scope: 'Real isolated PostgreSQL; player events, inventory removal receipts and depleted-treasury state are explicit fixtures, no real wallets or Minecraft inventory/payment proof',
  status: 'fail', checks, schema, publicTransactions: 0 }
let schemaCreated = false
try {
  await administrator.query('CREATE SCHEMA ' + schema)
  schemaCreated = true
  const economy = await createGameEconomy({ pool, allowLegacyGameCoinsFixture: true })
  const join = event(alice, 'player_join')
  const first = await economy.handle(join)
  assert.equal(first.balance.available, '100')
  assert.deepEqual(await economy.handle(join), first)
  await economy.handle(event(alice, 'player_join'))
  await economy.handle(event(bob, 'player_join'))
  await economy.handle(event(outsider, 'wallet'))
  assert.equal((await economy.balance(alice.playerId)).available, '100')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ac_game_ledger WHERE kind='starter_grant'")).rows[0].n, 3)
  check('one-time starter grants and durable join retries')

  const prepare = event(alice, 'pay', ['EconomyBob', '25'])
  const preview = await economy.handle(prepare)
  assert.equal(preview.status, 'ok')
  assert.deepEqual(await economy.handle(prepare), preview)
  assert.equal((await economy.balance(alice.playerId)).available, '100')
  const denied = await economy.handle(event(outsider, 'accept', [preview.previewId]))
  assert.equal(denied.status, 'refused')
  assert.equal((await economy.balance(bob.playerId)).available, '100')
  check('payment preview does not spend and another player cannot confirm')

  const confirm = event(alice, 'accept', [preview.previewId])
  const paid = await economy.handle(confirm)
  assert.equal(paid.status, 'ok')
  assert.equal(paid.replay, false)
  assert.deepEqual(await economy.handle(confirm), paid)
  assert.equal((await economy.handle(event(alice, 'accept', [preview.previewId]))).replay, true)
  assert.equal((await economy.balance(alice.playerId)).available, '75')
  assert.equal((await economy.balance(bob.playerId)).available, '125')
  const ledger = (await pool.query("SELECT sum(delta_available)::text AS net,count(*)::int AS n FROM ac_game_ledger WHERE kind='transfer'")).rows[0]
  assert.equal(ledger.net, '0'); assert.equal(ledger.n, 2)
  check('confirmed transfer conserves coins and repeated confirmations pay zero extra')

  await assert.rejects(economy.handle({ ...prepare, args: ['EconomyBob', '26'] }), /GAME_OPERATION_BINDING_CONFLICT/)
  await assert.rejects(economy.handle({ ...prepare, ...bob }), /GAME_OPERATION_BINDING_CONFLICT/)
  for (const amount of ['0', '-1', '1.5', '1000']) {
    assert.equal((await economy.handle(event(alice, 'pay', ['EconomyBob', amount]))).status, 'refused')
  }
  assert.equal((await economy.handle(event(alice, 'pay', ['UnknownPlayer', '1']))).status, 'refused')
  assert.equal((await economy.balance(alice.playerId)).available, '75')
  check('immutable operation binding, whole positive amounts and overdraft checks')

  const pending = await economy.handle(event(alice, 'pay', ['EconomyBob', '70']))
  const other = await economy.handle(event(alice, 'pay', ['EconomyBob', '10']))
  await economy.handle(event(alice, 'accept', [other.previewId]))
  assert.equal((await economy.handle(event(alice, 'accept', [pending.previewId]))).status, 'refused')
  const totals = (await pool.query('SELECT sum(available+held)::text AS total,min(available)::text AS smallest FROM ac_game_players')).rows[0]
  assert.equal(totals.total, '300'); assert.ok(BigInt(totals.smallest) >= 0n)
  assert.equal((await economy.handle(event(alice, 'jobs'))).status, 'ok')
  check('confirmation rechecks available funds and no unsupported paid jobs are invented')

  await createGameEconomy({ pool, allowLegacyGameCoinsFixture: true })
  let treasury = (await pool.query("SELECT * FROM ac_game_shop_treasury WHERE id='shop'")).rows[0]
  assert.equal(treasury.available, '10000'); assert.equal(treasury.held, '0')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ac_game_shop_ledger WHERE kind='operator_seed'")).rows[0].n, 1)
  const beforeSale = await economy.balance(alice.playerId)
  const inventoryPlayerId = randomUUID() // Disclosed fixture: an owned bot's inventory UUID.
  const saleEvent = { ...event(alice, 'sell', ['oak_planks', '3']), inventoryPlayerId }
  const sale = await economy.prepareSale(saleEvent)
  assert.equal(sale.status, 'ok'); assert.equal(sale.reward, '6'); assert.equal(sale.item, 'minecraft:oak_planks')
  assert.match(sale.receivingOperationId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(await economy.prepareSale(saleEvent), sale)
  assert.equal(sale.inventoryPlayerId, inventoryPlayerId)
  assert.deepEqual(await economy.balance(alice.playerId), beforeSale)
  treasury = (await pool.query("SELECT * FROM ac_game_shop_treasury WHERE id='shop'")).rows[0]
  assert.equal(treasury.available, '9994'); assert.equal(treasury.held, '6')
  await assert.rejects(economy.prepareSale({ ...saleEvent, args: ['oak_planks', '4'] }), /GAME_OPERATION_BINDING_CONFLICT/)
  check('finite shop funding is seeded once and sale preparation holds coins without paying')

  const resumed = await economy.getSale({ saleId: sale.saleId, playerId: alice.playerId })
  assert.equal(resumed.receivingOperationId, sale.receivingOperationId)
  assert.equal(resumed.inventoryPlayerId, inventoryPlayerId)
  assert.equal(resumed.item, sale.item); assert.equal(resumed.count, sale.count); assert.equal(resumed.reward, sale.reward)
  assert.equal(resumed.state, 'prepared')
  const unknownPlayer = randomUUID()
  const hidden = await economy.getSale({ saleId: sale.saleId, playerId: unknownPlayer })
  assert.equal(hidden.status, 'refused'); assert.equal(hidden.saleId, undefined)
  assert.equal(await economy.balance(unknownPlayer), null)
  assert.equal((await economy.getSale({ saleId: randomUUID(), playerId: alice.playerId })).status, 'refused')
  await assert.rejects(economy.prepareSale({ ...saleEvent, inventoryPlayerId: bob.playerId }), /GAME_OPERATION_BINDING_CONFLICT/)
  await assert.rejects(pool.query('UPDATE ac_game_sales SET inventory_player_id=$2 WHERE sale_id=$1', [sale.saleId, bob.playerId]), /GAME_SALE_TERMS_IMMUTABLE/)
  assert.deepEqual(await economy.balance(alice.playerId), beforeSale)
  check('owner-only sale retry returns original immutable inventory target and operation without grants')

  const receipt = { operationId: sale.receivingOperationId, item: sale.item, count: sale.count, removed: true }
  await assert.rejects(economy.completeSale({ saleId: sale.saleId, playerId: outsider.playerId, receipt }), /GAME_SALE_RECEIPT_BINDING_CONFLICT/)
  await assert.rejects(economy.completeSale({ saleId: sale.saleId, playerId: alice.playerId, receipt: { ...receipt, count: 4 } }), /GAME_SALE_RECEIPT_BINDING_CONFLICT/)
  await assert.rejects(economy.completeSale({ saleId: sale.saleId, playerId: alice.playerId, receipt: { ...receipt, removed: false } }), /INVALID_GAME_SALE_RECEIPT/)
  assert.equal((await economy.completeSale({ saleId: sale.saleId, playerId: alice.playerId, receipt })).replay, false)
  assert.equal((await economy.completeSale({ saleId: sale.saleId, playerId: alice.playerId, receipt })).replay, true)
  assert.equal((await economy.getSale({ saleId: sale.saleId, playerId: alice.playerId })).state, 'completed')
  assert.equal((await economy.balance(alice.playerId)).available, String(BigInt(beforeSale.available) + 6n))
  treasury = (await pool.query("SELECT * FROM ac_game_shop_treasury WHERE id='shop'")).rows[0]
  assert.equal(treasury.available, '9994'); assert.equal(treasury.held, '0')
  check('only an exact bound removal receipt settles a sale and receipt replay pays zero extra')

  const cancelled = await economy.prepareSale(event(bob, 'sell', ['cobblestone', '2']))
  assert.equal(cancelled.inventoryPlayerId, bob.playerId)
  await assert.rejects(economy.completeSale({ saleId: cancelled.saleId, playerId: bob.playerId, receipt }), /GAME_SALE_RECEIPT_BINDING_CONFLICT/)
  const unchangedReceipt = { operationId: cancelled.receivingOperationId, item: cancelled.item, count: cancelled.count, removed: false }
  assert.equal((await economy.cancelSale({ saleId: cancelled.saleId, playerId: bob.playerId, receipt: unchangedReceipt })).state, 'cancelled')
  assert.equal((await economy.cancelSale({ saleId: cancelled.saleId, playerId: bob.playerId, receipt: unchangedReceipt })).replay, true)
  assert.equal((await economy.getSale({ saleId: cancelled.saleId, playerId: bob.playerId })).state, 'cancelled')
  await assert.rejects(economy.completeSale({ saleId: cancelled.saleId, playerId: bob.playerId, receipt: { ...unchangedReceipt, removed: true } }), /GAME_SALE_RECEIPT_BINDING_CONFLICT/)
  treasury = (await pool.query("SELECT * FROM ac_game_shop_treasury WHERE id='shop'")).rows[0]
  assert.equal(treasury.available, '9994'); assert.equal(treasury.held, '0')
  const playerSupply = BigInt((await pool.query('SELECT sum(available+held)::text AS n FROM ac_game_players')).rows[0].n)
  assert.equal(playerSupply + BigInt(treasury.available) + BigInt(treasury.held), 10300n)
  const treasuryLedger = (await pool.query('SELECT sum(delta_available)::text AS available,sum(delta_held)::text AS held FROM ac_game_shop_ledger')).rows[0]
  assert.equal(treasuryLedger.available, treasury.available); assert.equal(treasuryLedger.held, treasury.held)
  check('confirmed no-removal cancellation releases only its hold and combined coin supply is conserved')

  // Explicit isolated fixture: all remaining treasury coins are reserved elsewhere.
  await pool.query("UPDATE ac_game_shop_treasury SET available=0,held=9994 WHERE id='shop'")
  const unfunded = await economy.prepareSale(event(alice, 'sell', ['cobblestone', '1']))
  assert.equal(unfunded.status, 'refused'); assert.equal(unfunded.receivingOperationId, undefined)
  assert.equal((await economy.prepareSale(event(alice, 'sell', ['diamond', '1']))).status, 'refused')
  assert.equal((await economy.prepareSale(event(alice, 'sell', ['cobblestone', '65']))).status, 'refused')
  check('unfunded or unsupported sales never authorize inventory removal')
  report.status = 'pass'
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  await pool.end()
  if (schemaCreated) await administrator.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await administrator.end()
  const output = new URL(`../../evidence/runs/playable-economy/${randomUUID()}/`, import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence: output.href, error: report.error }))
}
