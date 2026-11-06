import { json, stable } from './canonical.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'

export async function createWorldAssetStore(pool) {
  if (!pool?.query || !pool?.connect) throw Error('WORLD_ASSET_DURABLE_POOL_REQUIRED')
  await pool.query(`CREATE TABLE IF NOT EXISTS ac_world_asset_records (
    deployment_id text NOT NULL, record_key text NOT NULL, body jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(deployment_id,record_key));
    CREATE TABLE IF NOT EXISTS ac_world_asset_backing (
    deployment_id text NOT NULL, native_receipt_id text NOT NULL, custody_key text NOT NULL,
    operation_id text NOT NULL, PRIMARY KEY(deployment_id,native_receipt_id), UNIQUE(deployment_id,custody_key));`)
  const context = new AsyncLocalStorage()
  const query = (...args) => (context.getStore() || pool).query(...args)
  return {
    async get(deploymentId, key) { return (await query('SELECT body FROM ac_world_asset_records WHERE deployment_id=$1 AND record_key=$2', [deploymentId, key])).rows[0]?.body || null },
    async put(deploymentId, key, value) { await query(`INSERT INTO ac_world_asset_records(deployment_id,record_key,body) VALUES($1,$2,$3)
      ON CONFLICT(deployment_id,record_key) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`, [deploymentId, key, json(value)]) },
    async list(deploymentId, prefix) { return (await query('SELECT body FROM ac_world_asset_records WHERE deployment_id=$1 AND starts_with(record_key,$2)', [deploymentId, prefix])).rows.map(row => row.body) },
    async backing(deploymentId, receiptId, custodyKey, operationId) {
      await query('INSERT INTO ac_world_asset_backing(deployment_id,native_receipt_id,custody_key,operation_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [deploymentId, receiptId, custodyKey, operationId])
      const row = (await query('SELECT * FROM ac_world_asset_backing WHERE deployment_id=$1 AND (native_receipt_id=$2 OR custody_key=$3)', [deploymentId, receiptId, custodyKey])).rows
      if (row.length !== 1 || row[0].operation_id !== operationId || row[0].native_receipt_id !== receiptId || row[0].custody_key !== custodyKey) throw Error('WORLD_ASSET_NATIVE_BACKING_ALREADY_USED')
    },
    async lock(deploymentId, key, work) {
      const previous = context.getStore(), tx = previous || await pool.connect(), lock = stable([deploymentId, key])
      try { await tx.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]); return await context.run(tx, work) }
      finally { try { await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]) } finally { if (!previous) tx.release() } }
    }
  }
}
