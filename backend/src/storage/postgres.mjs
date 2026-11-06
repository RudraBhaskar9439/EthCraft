import pg from 'pg'
import { readFile } from 'node:fs/promises'

export class PostgresStore {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 })
  }

  query(text, parameters = []) { return this.pool.query(text, parameters) }

  async transaction(work) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async migrate(files) {
    // Callers supply trusted, versioned SQL files; request data never selects a migration.
    for (const file of files) await this.query(await readFile(file, 'utf8'))
  }

  close() { return this.pool.end() }
}
