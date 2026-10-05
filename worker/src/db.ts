import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { getConfig } from './config'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: getConfig().databaseUrl, max: 5 })
  return pool
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<QueryResult<T>> {
  return (client ?? getPool()).query<T>(text, params)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
      // ignore
    }
    throw error
  } finally {
    client.release()
  }
}
