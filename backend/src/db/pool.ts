import { types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { getConfig } from '../config'

types.setTypeParser(20, (value) => Number(value))

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConfig().databaseUrl, max: 10 })
    pool.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', msg: 'idle database client failed', error: error.message }))
    })
  }
  return pool
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<QueryResult<T>> {
  return (client ?? getPool()).query<T>(text, params)
}

export function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Runs `fn` in a transaction and retries database deadlocks.
 * `fn` must be safe to run again: it may not perform external side effects.
 * Queue publishes and file writes happen after commit.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection may already be aborted.
      }
      const code = pgCode(error)
      if ((code === '40P01' || code === '40001') && attempt < 3) {
        last = error
        continue
      }
      throw error
    } finally {
      client.release()
    }
  }
  throw last
}
