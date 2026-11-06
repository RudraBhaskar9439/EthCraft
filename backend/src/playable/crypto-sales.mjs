import { createHash } from 'node:crypto'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const ADDRESS = /^0x[a-f0-9]{40}$/i
const prices = { 'minecraft:cobblestone': 1n, 'minecraft:oak_planks': 2n }
const uuid = text => {
  const hex = createHash('sha256').update(text).digest('hex').slice(0, 32)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
const schema = `CREATE TABLE IF NOT EXISTS ac_crypto_item_sales (
 sale_id uuid PRIMARY KEY, player_id uuid NOT NULL, fingerprint text NOT NULL,
 inventory_player_id uuid NOT NULL, item text NOT NULL, count integer NOT NULL CHECK(count BETWEEN 1 AND 64),
 reward numeric(78,0) NOT NULL CHECK(reward>0), chain_id bigint NOT NULL, token text NOT NULL,
 treasury text NOT NULL, recipient text NOT NULL, manifest_id text NOT NULL,
 removal_id uuid NOT NULL UNIQUE, state text NOT NULL CHECK(state IN ('reserved','removed','paid','cancelled')),
 inventory_receipt jsonb, payout_receipt jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION protect_crypto_item_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.sale_id,NEW.player_id,NEW.fingerprint,NEW.inventory_player_id,NEW.item,NEW.count,
     NEW.reward,NEW.chain_id,NEW.token,NEW.treasury,NEW.recipient,NEW.manifest_id,NEW.removal_id,NEW.created_at)
 IS DISTINCT FROM
    (OLD.sale_id,OLD.player_id,OLD.fingerprint,OLD.inventory_player_id,OLD.item,OLD.count,
     OLD.reward,OLD.chain_id,OLD.token,OLD.treasury,OLD.recipient,OLD.manifest_id,OLD.removal_id,OLD.created_at)
 OR (OLD.inventory_receipt IS NOT NULL AND NEW.inventory_receipt IS DISTINCT FROM OLD.inventory_receipt)
 OR (OLD.payout_receipt IS NOT NULL AND NEW.payout_receipt IS DISTINCT FROM OLD.payout_receipt)
 OR (OLD.state IN ('paid','cancelled') AND NEW.state IS DISTINCT FROM OLD.state)
 OR (OLD.state='removed' AND NEW.state NOT IN ('removed','paid'))
 THEN RAISE EXCEPTION 'CRYPTO_SALE_TERMS_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crypto_item_sale_immutable ON ac_crypto_item_sales;
CREATE TRIGGER crypto_item_sale_immutable BEFORE UPDATE ON ac_crypto_item_sales
 FOR EACH ROW EXECUTE FUNCTION protect_crypto_item_sale();`

/** Inventory is removed only after finite token funds are reserved. Unknown effects retain the original claim. */
export async function createCryptoItemSales({ pool, treasuryStatus, recipient, removeInventory, payout }) {
  if (!pool || ![treasuryStatus, recipient, removeInventory, payout].every(fn => typeof fn === 'function')) throw Error('crypto_sale_dependencies')
  await pool.query(schema)
  const pending = new Map()
  const owned = async (id, playerId) => {
    if (!UUID.test(id) || !UUID.test(playerId)) throw Error('sale_identity')
    const row = (await pool.query('SELECT * FROM ac_crypto_item_sales WHERE sale_id=$1 AND player_id=$2', [id, playerId.toLowerCase()])).rows[0]
    if (!row) throw Error('That test-token sale does not belong to you.')
    return row
  }
  async function prepare(event, subject) {
    if (!UUID.test(event.playerId || '') || typeof event.operationId !== 'string' || event.operationId.length > 200) throw Error('sale_player_event')
    const playerId = event.playerId.toLowerCase(), actor = (subject.inventoryPlayerId || playerId).toLowerCase()
    const item = 'minecraft:' + String(subject.item).replace(/^minecraft:/, '')
    const count = Number(subject.count)
    if (!UUID.test(actor) || !prices[item] || !Number.isSafeInteger(count) || count < 1 || count > 64) throw Error('Sell 1 to 64 actual oak_planks or cobblestone.')
    const id = uuid('crypto-sale:' + event.operationId)
    const fingerprint = createHash('sha256').update(JSON.stringify({ playerId, actor, item, count })).digest('hex')
    const old = (await pool.query('SELECT * FROM ac_crypto_item_sales WHERE sale_id=$1', [id])).rows[0]
    if (old) {
      if (old.fingerprint !== fingerprint || old.player_id !== playerId) throw Error('sale_terms_changed')
      return old
    }
    const to = (await recipient(playerId)).toLowerCase()
    const reward = prices[item] * BigInt(count) * 10n ** 18n
    const payoutTerms={recipient:to,amount:reward.toString()}
    const status = await treasuryStatus(payoutTerms)
    if (![31337, 1301].includes(status.chainId) || status.decimals !== 18 || !ADDRESS.test(status.token) || !ADDRESS.test(status.address) || !ADDRESS.test(to) || !status.manifestId || !status.gasReady) throw Error('Test-token treasury is not ready; no items were removed.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['crypto-sale:' + status.chainId + ':' + status.address.toLowerCase() + ':' + status.token.toLowerCase()])
      const existing = (await client.query('SELECT * FROM ac_crypto_item_sales WHERE sale_id=$1', [id])).rows[0]
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.player_id !== playerId) throw Error('sale_terms_changed')
        await client.query('COMMIT'); return existing
      }
      const current = await treasuryStatus(payoutTerms)
      if(current.manifestId!==status.manifestId || current.chainId!==status.chainId || current.token.toLowerCase()!==status.token.toLowerCase() || current.address.toLowerCase()!==status.address.toLowerCase() || !current.gasReady)throw Error('treasury_context_changed')
      const held = (await client.query("SELECT COALESCE(SUM(reward),0)::text AS amount FROM ac_crypto_item_sales WHERE chain_id=$1 AND treasury=$2 AND token=$3 AND state IN ('reserved','removed')", [status.chainId, status.address.toLowerCase(), status.token.toLowerCase()])).rows[0].amount
      if (BigInt(current.balance) - BigInt(held) < reward) throw Error('The finite test-token treasury has insufficient unreserved CITY. No items were removed.')
      const row = (await client.query(`INSERT INTO ac_crypto_item_sales
        (sale_id,player_id,fingerprint,inventory_player_id,item,count,reward,chain_id,token,treasury,recipient,manifest_id,removal_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved') RETURNING *`,
      [id, playerId, fingerprint, actor, item, count, reward.toString(), status.chainId, status.token.toLowerCase(), status.address.toLowerCase(), to, status.manifestId, uuid(id + ':native-removal')])).rows[0]
      await client.query('COMMIT'); return row
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  function boundReceipt(row, receipt) {
    return receipt?.operationId === row.removal_id && receipt.playerId === row.player_id &&
      receipt.inventoryPlayerId === row.inventory_player_id && receipt.item === row.item && Number(receipt.count) === row.count
  }
  async function settle(row) {
    if (row.state === 'paid') return `Sale ${row.sale_id} already paid ${BigInt(row.reward) / 10n ** 18n} test CITY. No additional items or tokens moved.`
    if (row.state === 'cancelled') return `Sale ${row.sale_id} was cancelled after confirmed no item removal.`
    if (row.state === 'reserved') {
      const receipt = await removeInventory({ operationId: row.removal_id, playerId: row.player_id,
        inventoryPlayerId: row.inventory_player_id, item: row.item, count: row.count })
      if (!boundReceipt(row, receipt) || typeof receipt.removed !== 'boolean') throw Error('inventory_receipt_binding')
      const state = receipt.removed ? 'removed' : 'cancelled'
      row = (await pool.query("UPDATE ac_crypto_item_sales SET state=$2,inventory_receipt=$3 WHERE sale_id=$1 AND state='reserved' RETURNING *", [row.sale_id, state, JSON.stringify(receipt)])).rows[0] || await owned(row.sale_id, row.player_id)
      if (row.state === 'cancelled') return `Sale ${row.sale_id} cancelled: insufficient actual items. No CITY was paid.`
    }
    const proof = await payout({ operationId: row.sale_id + ':payout', chainId: Number(row.chain_id), manifestId: row.manifest_id,
      token: row.token, treasury: row.treasury, recipient: row.recipient, amount: row.reward })
    if (proof?.status !== 'confirmed') return `Sale ${row.sale_id}: items received; original CITY payout is pending. Use /market retry ${row.sale_id}.`
    if (Number(proof.chainId) !== Number(row.chain_id) || proof.token?.toLowerCase() !== row.token ||
      proof.from?.toLowerCase() !== row.treasury || proof.to?.toLowerCase() !== row.recipient ||
      BigInt(proof.amount) !== BigInt(row.reward) || !/^0x[a-f0-9]{64}$/i.test(proof.transactionHash || '')) throw Error('payout_receipt_binding')
    await pool.query("UPDATE ac_crypto_item_sales SET state='paid',payout_receipt=$2 WHERE sale_id=$1 AND state='removed'", [row.sale_id, JSON.stringify(proof)])
    return `Sold ${row.count} ${row.item.replace('minecraft:', '')} for ${BigInt(row.reward) / 10n ** 18n} test CITY. Sale ${row.sale_id}. Transaction ${proof.transactionHash}`
  }
  async function run(id, playerId, create) {
    const key=id+':'+playerId.toLowerCase()
    if (pending.has(key)) return pending.get(key)
    const work = (async () => {
      let row
      try { row = create ? await create() : await owned(id, playerId); return await settle(row) }
      catch (error) {
        if (row) return `Sale ${row.sale_id} needs reconciliation: ${error.message}. Use /market retry ${row.sale_id}; do not create a replacement sale.`
        throw error
      }
    })().finally(() => pending.delete(key))
    pending.set(key, work); return work
  }
  return {
    sell: (event, subject) => run(uuid('crypto-sale:' + event.operationId), event.playerId, () => prepare(event, subject)),
    retry: ({ saleId, playerId }) => run(saleId, playerId),
    status: ({ saleId, playerId }) => owned(saleId, playerId)
  }
}
