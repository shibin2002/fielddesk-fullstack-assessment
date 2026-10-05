import type { FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import { csvLine } from './csv'
import { getPool } from './db/pool'
import type { AuthContext } from './types'
import { compileFilter, type ListQuery } from './workOrders'

const HEADER = ['reference_number', 'title', 'description', 'priority', 'status', 'technician', 'site_name', 'scheduled_start', 'scheduled_end', 'created_at', 'updated_at']

type ExportRow = {
  id: string
  reference_number: string
  title: string
  description: string
  priority: string
  status: string
  technician_name: string | null
  site_name: string
  scheduled_start: Date | null
  scheduled_end: Date | null
  created_at: Date
  updated_at: Date
}

export async function streamWorkOrderCsv(
  reply: FastifyReply,
  auth: AuthContext,
  filters: Partial<ListQuery>,
): Promise<void> {
  const { where, params } = compileFilter(auth, filters)
  const client = await getPool().connect()
  let released = false
  const release = () => {
    if (!released) {
      released = true
      client.release()
    }
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '60s'`)
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="fielddesk-work-orders.csv"',
      'Cache-Control': 'no-store',
      'X-Request-Id': reply.request.id,
    })
    reply.raw.write(csvLine(HEADER))
    let cursorCreated: string | null = null
    let cursorId: string | null = null
    for (;;) {
      if (reply.raw.destroyed) break
      const rows = await fetchBatch(client, where, params, cursorCreated, cursorId)
      if (rows.length === 0) break
      for (const row of rows) {
        reply.raw.write(csvLine([
          row.reference_number,
          row.title,
          row.description,
          row.priority,
          row.status,
          row.technician_name,
          row.site_name,
          row.scheduled_start,
          row.scheduled_end,
          row.created_at,
          row.updated_at,
        ]))
      }
      const last = rows[rows.length - 1]
      cursorCreated = new Date(last.created_at).toISOString()
      cursorId = last.id
      if (rows.length < 200) break
    }
    reply.raw.end()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (!reply.raw.headersSent) throw error
    reply.raw.end()
  } finally {
    release()
  }
}

async function fetchBatch(
  client: PoolClient,
  where: string,
  params: unknown[],
  cursorCreated: string | null,
  cursorId: string | null,
): Promise<ExportRow[]> {
  const createdRef = params.length + 1
  const idRef = params.length + 2
  const result = await client.query<ExportRow>(
    `SELECT w.id, w.reference_number, w.title, w.description, w.priority, w.status,
            t.name AS technician_name, w.site_name, w.scheduled_start, w.scheduled_end,
            w.created_at, w.updated_at
     FROM work_orders w
     LEFT JOIN users t ON t.id = w.assigned_technician_id
     WHERE ${where}
       AND (
         $${createdRef}::timestamptz IS NULL
         OR (w.created_at, w.id) < ($${createdRef}::timestamptz, $${idRef}::uuid)
       )
     ORDER BY w.created_at DESC, w.id DESC
     LIMIT 200`,
    [...params, cursorCreated, cursorId],
  )
  return result.rows
}
