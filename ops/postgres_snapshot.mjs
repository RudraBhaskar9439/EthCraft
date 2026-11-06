import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'

const require = createRequire(new URL('../backend/package.json', import.meta.url))
const { Client } = require('pg')
const settings = JSON.parse(await readFile(new URL('../.local/backend/environment.json', import.meta.url)))
const url = new URL(settings.databaseUrl)
const mode = process.argv[2]
if (!['snapshot', 'fingerprint'].includes(mode) || url.hostname !== '127.0.0.1' || url.port !== '55432') throw new Error('owned_local_database_required')
if (process.argv[3]) {
  if (!/^agentcity_restore_[a-f0-9]{32}$/.test(process.argv[3])) throw new Error('isolated_restore_database_required')
  url.pathname = '/' + process.argv[3]
}
const client = new Client({ connectionString: url.toString(), statement_timeout: 30000 })
try {
  await client.connect()
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL TIME ZONE 'UTC'")
  const snapshot = mode === 'snapshot' ? (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id : null
  const tables = (await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename")).rows
  const fingerprints = []
  const quote = name => '"' + name.replaceAll('"', '""') + '"'
  for (const { schemaname, tablename } of tables) {
    const table = quote(schemaname) + '.' + quote(tablename)
    const result = (await client.query(`SELECT count(*)::text AS rows, md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS contents FROM ${table} t`)).rows[0]
    fingerprints.push({ schema: schemaname, table: tablename, ...result })
  }
  process.stdout.write(JSON.stringify({ snapshot, tables: fingerprints }) + '\n')
  if (mode === 'snapshot') {
    process.stdin.resume()
    const timeout = setTimeout(() => process.stdin.destroy(new Error('snapshot_holder_expired')), 180000)
    try { await once(process.stdin, 'data') } finally { clearTimeout(timeout) }
  }
  await client.query('COMMIT')
} finally { await client.end(); process.stdin.pause() }
