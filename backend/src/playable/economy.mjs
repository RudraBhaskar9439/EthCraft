import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const NAME = /^[A-Za-z0-9_]{3,16}$/
const MAX_AMOUNT = 9223372036854775807n
export const GAME_SHOP_CATALOG = Object.freeze({ 'minecraft:cobblestone': 1, 'minecraft:oak_planks': 2 })
const visible = row => row && ({ playerId: row.player_id, playerName: row.player_name,
  available: String(row.available), held: String(row.held), currency: 'Game Coins' })
const reply = (status, messages, details = {}) => ({ status, messages, ...details })
const refuse = message => reply('refused', [message])

export async function createGameEconomy({ pool, allowLegacyGameCoinsFixture = false }) {
  if (!pool?.query || !pool?.connect) throw new Error('GAME_ECONOMY_POOL_REQUIRED')
  if (allowLegacyGameCoinsFixture === true) await pool.query(await readFile(new URL('./economy.sql', import.meta.url), 'utf8'))

  async function onboard(tx, event) {
    const added = await tx.query(`INSERT INTO ac_game_players(player_id,player_name,name_key)
      VALUES($1,$2,$3) ON CONFLICT(player_id) DO NOTHING RETURNING player_id`,
    [event.playerId, event.playerName, event.playerName.toLowerCase()])
    if (added.rowCount) {
      await tx.query(`INSERT INTO ac_game_ledger(operation_key,player_id,kind,delta_available)
        VALUES($1,$2,'starter_grant',100)`, ['starter:' + event.playerId, event.playerId])
    }
    const account = (await tx.query('SELECT * FROM ac_game_players WHERE player_id=$1', [event.playerId])).rows[0]
    if (account.name_key !== event.playerName.toLowerCase()) throw new Error('GAME_PLAYER_IDENTITY_CHANGED')
    return { account, joined: added.rowCount === 1 }
  }

  async function act(tx, event, account, joined) {
    const { action, args } = event
    if (['player_join', 'balance', 'wallet'].includes(action)) {
      const history = (await tx.query(`SELECT kind,delta_available::text,delta_held::text,created_at
        FROM ac_game_ledger WHERE player_id=$1 ORDER BY id DESC LIMIT 5`, [event.playerId])).rows
      return reply('ok', [joined ? 'Welcome! You received your one-time 100 Game Coins starter grant.' :
        `${account.player_name}: ${account.available} Game Coins available, ${account.held} held.`,
      'Game Coins exist only on this server and have no real-world value.',
      ...history.map(row => `Recent ${row.kind === 'starter_grant' ? 'starter grant' : row.kind === 'sale_reward' ? 'shop sale' : 'transfer'}: ${BigInt(row.delta_available) > 0n ? '+' : ''}${row.delta_available} Game Coins.`)],
      { balance: visible(account), history })
    }
    if (action === 'jobs') return reply('ok', [
      'Agent tools: build platforms or small shelters, collect from your source chest, deliver to your destination chest, and sell carried oak_planks or cobblestone. Use /agent status for your latest task.',
      'Player job rewards are not available yet. You can transfer Game Coins with /pay <player> <amount>.'])
    if (action === 'sell') {
      if (args.length !== 2 || !/^[1-9][0-9]?$/.test(args[1]) || Number(args[1]) > 64) {
        return refuse('Use /sell cobblestone <1-64> or /sell oak_planks <1-64>.')
      }
      const item = args[0].includes(':') ? args[0] : 'minecraft:' + args[0]
      if (!Object.hasOwn(GAME_SHOP_CATALOG, item)) return refuse('The shop buys cobblestone for 1 coin each and oak_planks for 2 coins each.')
      const count = Number(args[1]), reward = BigInt(count * GAME_SHOP_CATALOG[item])
      const treasury = (await tx.query("SELECT available FROM ac_game_shop_treasury WHERE id='shop' FOR UPDATE")).rows[0]
      if (BigInt(treasury.available) < reward) return refuse('The finite shop treasury cannot fund this sale. No item removal was requested.')
      const receivingOperationId = randomUUID()
      await tx.query(`INSERT INTO ac_game_sales(sale_id,player_id,inventory_player_id,item,count,reward,receiving_operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [event.operationId, event.playerId, event.inventoryPlayerId, item, count, String(reward), receivingOperationId])
      await tx.query("UPDATE ac_game_shop_treasury SET available=available-$1::bigint,held=held+$1::bigint WHERE id='shop'", [String(reward)])
      await tx.query(`INSERT INTO ac_game_shop_ledger(operation_key,sale_id,kind,delta_available,delta_held)
        VALUES($1,$2,'reserve',-$3::bigint,$3::bigint)`, ['reserve:' + event.operationId, event.operationId, String(reward)])
      return reply('ok', [`Sale prepared: ${count} ${item} for ${reward} Game Coins. Coins are held from the finite shop treasury; payment waits for confirmed item removal.`],
        { saleId: event.operationId, inventoryPlayerId: event.inventoryPlayerId, item, count, reward: String(reward), receivingOperationId, state: 'prepared' })
    }
    if (action === 'pay') {
      if (args.length !== 2 || !NAME.test(args[0]) || !/^[1-9][0-9]{0,18}$/.test(args[1]) || BigInt(args[1]) > MAX_AMOUNT) {
        return refuse('Use /pay <known player> <positive whole Game Coins>.')
      }
      const recipient = (await tx.query('SELECT * FROM ac_game_players WHERE name_key=$1', [args[0].toLowerCase()])).rows[0]
      if (!recipient) return refuse('That player must join the server before you can pay them.')
      if (recipient.player_id === event.playerId) return refuse('Choose another player to pay.')
      if (BigInt(account.available) < BigInt(args[1])) return refuse('You do not have enough available Game Coins.')
      const transfer = (await tx.query(`INSERT INTO ac_game_transfers(transfer_id,sender_id,recipient_id,amount,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') RETURNING expires_at`,
      [event.operationId, event.playerId, recipient.player_id, args[1]])).rows[0]
      return reply('ok', [`Pay ${args[1]} Game Coins to ${recipient.player_name}?`,
        `Confirm within 5 minutes: /accept ${event.operationId}`, 'This preview has not spent or reserved coins.'],
      { previewId: event.operationId, amount: args[1], recipient: recipient.player_name, expiresAt: transfer.expires_at.toISOString() })
    }
    if (action === 'accept') {
      if (args.length !== 1 || !UUID.test(args[0])) return refuse('Use /accept <payment preview ID>.')
      const transfer = (await tx.query('SELECT * FROM ac_game_transfers WHERE transfer_id=$1 FOR UPDATE', [args[0]])).rows[0]
      if (!transfer || transfer.sender_id !== event.playerId) return refuse('Only the player who prepared this payment can confirm it.')
      const recipient = (await tx.query('SELECT player_name FROM ac_game_players WHERE player_id=$1', [transfer.recipient_id])).rows[0]
      if (transfer.state === 'confirmed') return reply('ok', ['This payment was already completed. No additional coins were sent.'],
        { transferId: transfer.transfer_id, amount: String(transfer.amount), replay: true })
      const fresh = (await tx.query('SELECT expires_at > clock_timestamp() AS valid FROM ac_game_transfers WHERE transfer_id=$1', [args[0]])).rows[0]
      if (!fresh.valid) return refuse('This payment preview expired. Prepare a new /pay request; no coins were spent.')
      // Both players are locked in UUID order even for opposing transfers.
      const locked = (await tx.query('SELECT * FROM ac_game_players WHERE player_id=ANY($1::uuid[]) ORDER BY player_id FOR UPDATE',
        [[transfer.sender_id, transfer.recipient_id]])).rows
      const sender = locked.find(row => row.player_id === transfer.sender_id)
      const receiver = locked.find(row => row.player_id === transfer.recipient_id)
      if (BigInt(sender.available) < BigInt(transfer.amount)) return refuse('You no longer have enough available Game Coins. No payment was made.')
      if (BigInt(receiver.available) + BigInt(transfer.amount) > MAX_AMOUNT) return refuse('The recipient cannot receive this amount.')
      await tx.query('UPDATE ac_game_players SET available=available-$2::bigint WHERE player_id=$1', [transfer.sender_id, transfer.amount])
      await tx.query('UPDATE ac_game_players SET available=available+$2::bigint WHERE player_id=$1', [transfer.recipient_id, transfer.amount])
      await tx.query(`INSERT INTO ac_game_ledger(operation_key,player_id,kind,delta_available)
        VALUES($1,$2,'transfer',-$4::bigint),($1,$3,'transfer',$4::bigint)`,
      ['transfer:' + transfer.transfer_id, transfer.sender_id, transfer.recipient_id, transfer.amount])
      await tx.query("UPDATE ac_game_transfers SET state='confirmed',confirmed_at=clock_timestamp() WHERE transfer_id=$1", [transfer.transfer_id])
      return reply('ok', [`Paid ${transfer.amount} Game Coins to ${recipient.player_name}.`],
        { transferId: transfer.transfer_id, amount: String(transfer.amount), replay: false })
    }
    return refuse('Unknown game payment action. Use /balance, /pay <player> <amount>, or /jobs.')
  }

  async function handle(input) {
    if (allowLegacyGameCoinsFixture !== true) throw new Error('GAME_COINS_RETIRED')
    if (!input || !UUID.test(input.operationId) || !UUID.test(input.playerId) || !NAME.test(input.playerName) ||
        typeof input.action !== 'string' || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string') ||
        input.args.length > 4 || input.args.some(arg => arg.length > 128) || !Number.isSafeInteger(input.createdAtMs) ||
        (input.inventoryPlayerId !== undefined && !UUID.test(input.inventoryPlayerId))) {
      throw new Error('INVALID_GAME_ECONOMY_EVENT')
    }
    const event = { operationId: input.operationId.toLowerCase(), playerId: input.playerId.toLowerCase(),
      playerName: input.playerName, action: input.action, args: input.args, createdAtMs: input.createdAtMs,
      ...(input.action === 'sell' ? { inventoryPlayerId: (input.inventoryPlayerId ?? input.playerId).toLowerCase() } : {}) }
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const { account, joined } = await onboard(tx, event)
      await tx.query('INSERT INTO ac_game_events(operation_id,player_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [event.operationId, event.playerId, event])
      const existing = (await tx.query('SELECT payload,response FROM ac_game_events WHERE operation_id=$1 FOR UPDATE', [event.operationId])).rows[0]
      if (!isDeepStrictEqual(existing.payload, event)) throw new Error('GAME_OPERATION_BINDING_CONFLICT')
      if (existing.response) { await tx.query('COMMIT'); return existing.response }
      const result = JSON.parse(JSON.stringify(await act(tx, event, account, joined)))
      await tx.query('UPDATE ac_game_events SET response=$2 WHERE operation_id=$1', [event.operationId, JSON.stringify(result)])
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally { tx.release() }
  }

  async function settleSale({ saleId, playerId, receipt }, removed) {
    if (!UUID.test(saleId) || !UUID.test(playerId) || !receipt || !UUID.test(receipt.operationId) ||
        receipt.removed !== removed || typeof receipt.item !== 'string' || !Number.isInteger(receipt.count)) {
      throw new Error('INVALID_GAME_SALE_RECEIPT')
    }
    const boundReceipt = { operationId: receipt.operationId.toLowerCase(), item: receipt.item, count: receipt.count, removed }
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const sale = (await tx.query('SELECT * FROM ac_game_sales WHERE sale_id=$1 FOR UPDATE', [saleId])).rows[0]
      if (!sale || sale.player_id !== playerId.toLowerCase() || sale.receiving_operation_id !== boundReceipt.operationId ||
          sale.item !== boundReceipt.item || sale.count !== boundReceipt.count) throw new Error('GAME_SALE_RECEIPT_BINDING_CONFLICT')
      if (sale.state !== 'prepared') {
        if (!isDeepStrictEqual(sale.receipt, boundReceipt)) throw new Error('GAME_SALE_RECEIPT_BINDING_CONFLICT')
        await tx.query('COMMIT')
        return reply('ok', [sale.state === 'completed' ? 'This sale was already paid. No additional coins were credited.' : 'This sale was already cancelled; no coins were paid.'],
          { saleId: sale.sale_id, state: sale.state, reward: String(sale.reward), replay: true })
      }
      const treasury = (await tx.query("SELECT * FROM ac_game_shop_treasury WHERE id='shop' FOR UPDATE")).rows[0]
      if (BigInt(treasury.held) < BigInt(sale.reward)) throw new Error('GAME_SALE_RESERVATION_MISSING')
      if (removed) {
        const account = (await tx.query('SELECT available FROM ac_game_players WHERE player_id=$1 FOR UPDATE', [sale.player_id])).rows[0]
        if (BigInt(account.available) + BigInt(sale.reward) > MAX_AMOUNT) throw new Error('GAME_SALE_BALANCE_OVERFLOW')
        await tx.query('UPDATE ac_game_players SET available=available+$2::bigint WHERE player_id=$1', [sale.player_id, sale.reward])
        await tx.query("UPDATE ac_game_shop_treasury SET held=held-$1::bigint WHERE id='shop'", [sale.reward])
        await tx.query(`INSERT INTO ac_game_ledger(operation_key,player_id,kind,delta_available)
          VALUES($1,$2,'sale_reward',$3)`, ['sale:' + sale.sale_id, sale.player_id, sale.reward])
        await tx.query(`INSERT INTO ac_game_shop_ledger(operation_key,sale_id,kind,delta_available,delta_held)
          VALUES($1,$2,'settle',0,-$3::bigint)`, ['settle:' + sale.sale_id, sale.sale_id, sale.reward])
      } else {
        await tx.query("UPDATE ac_game_shop_treasury SET available=available+$1::bigint,held=held-$1::bigint WHERE id='shop'", [sale.reward])
        await tx.query(`INSERT INTO ac_game_shop_ledger(operation_key,sale_id,kind,delta_available,delta_held)
          VALUES($1,$2,'cancel',$3::bigint,-$3::bigint)`, ['cancel:' + sale.sale_id, sale.sale_id, sale.reward])
      }
      const state = removed ? 'completed' : 'cancelled'
      await tx.query('UPDATE ac_game_sales SET state=$2,receipt=$3 WHERE sale_id=$1', [sale.sale_id, state, boundReceipt])
      await tx.query('COMMIT')
      return reply('ok', [removed ? `Sold ${sale.count} ${sale.item} for ${sale.reward} Game Coins.` : 'Sale cancelled after confirmed no item removal. No coins were paid.'],
        { saleId: sale.sale_id, state, reward: String(sale.reward), replay: false })
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally { tx.release() }
  }

  return { handle,
    prepareSale: event => handle({ ...event, action: 'sell', createdAtMs: event.createdAtMs ?? 0 }),
    getSale: async ({ saleId, playerId }) => {
      if (!UUID.test(saleId) || !UUID.test(playerId)) throw new Error('INVALID_GAME_SALE_LOOKUP')
      const sale = (await pool.query('SELECT * FROM ac_game_sales WHERE sale_id=$1 AND player_id=$2', [saleId, playerId])).rows[0]
      if (!sale) return refuse('That sale is unavailable or belongs to another player.')
      return reply('ok', [sale.state === 'prepared' ? 'Resuming the original sale and inventory operation.' : `This sale is ${sale.state}; no new inventory removal is authorized.`],
        { saleId: sale.sale_id, inventoryPlayerId: sale.inventory_player_id, item: sale.item, count: sale.count,
          reward: String(sale.reward), receivingOperationId: sale.receiving_operation_id, state: sale.state })
    },
    // Only the trusted worker calls these after an authoritative plugin receipt.
    // A network timeout or model statement is never a removal/cancellation receipt.
    completeSale: input => { if (allowLegacyGameCoinsFixture !== true) throw new Error('GAME_COINS_RETIRED'); return settleSale(input, true) }, cancelSale: input => settleSale(input, false),
    balance: async playerId => {
    if (!UUID.test(playerId)) throw new Error('INVALID_GAME_PLAYER_ID')
    return visible((await pool.query('SELECT * FROM ac_game_players WHERE player_id=$1', [playerId])).rows[0]) ?? null
  }, close: async () => {} }
}
