import fs from 'fs'
import path from 'path'
import { getPool } from './pool'

function migrationsDirectory(): string {
  return path.resolve(__dirname, '../../../database/migrations')
}

export async function migrate(): Promise<void> {
  const pool = getPool()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations')
  const seen = new Set(applied.rows.map((row) => row.id))
  const files = fs.readdirSync(migrationsDirectory()).filter((file) => file.endsWith('.sql')).sort()
  for (const file of files) {
    if (seen.has(file)) continue
    const sql = fs.readFileSync(path.join(migrationsDirectory(), file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(JSON.stringify({ level: 'info', msg: 'applied migration', file }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

if (require.main === module) {
  migrate()
    .then(async () => {
      await getPool().end()
    })
    .catch(async (error) => {
      console.error(error)
      await getPool().end().catch(() => undefined)
      process.exit(1)
    })
}
