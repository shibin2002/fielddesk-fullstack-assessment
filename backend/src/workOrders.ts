import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { writeAudit } from './audit'
import { pgCode, query, withTransaction } from './db/pool'
import { AppError } from './errors'
import { enqueueNotification } from './redis'
import { publish } from './realtime'
import { parseSchedule } from './scheduling'
import type { AuthContext, Priority, WorkOrderJson, WorkOrderRow, WorkStatus } from './types'

const priorities = ['low', 'medium', 'high', 'urgent'] as const
const statuses = ['open', 'scheduled', 'in_progress', 'completed', 'cancelled'] as const

export const createWorkOrderSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(140),
  description: z.string().trim().max(5000).optional().default(''),
  priority: z.enum(priorities),
  siteName: z.string().trim().min(2, 'Site name is required').max(160),
  technicianId: z.string().uuid().nullable().optional(),
  scheduledStart: z.string().datetime().nullable().optional(),
  scheduledEnd: z.string().datetime().nullable().optional(),
})

export const patchWorkOrderSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  description: z.string().trim().max(5000).optional(),
  priority: z.enum(priorities).optional(),
  siteName: z.string().trim().min(2).max(160).optional(),
  status: z.enum(statuses).optional(),
  version: z.number().int().positive(),
})

export const assignmentSchema = z.object({
  technicianId: z.string().uuid().nullable(),
  scheduledStart: z.string().datetime().nullable(),
  scheduledEnd: z.string().datetime().nullable(),
  version: z.number().int().positive(),
})

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  technicianId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['created_at', 'updated_at', 'scheduled_start', 'priority', 'status', 'reference', 'title']).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
})

export type ListQuery = z.infer<typeof listQuerySchema>

const SELECT_WORK_ORDER = `
  SELECT w.id, w.organisation_id, w.reference_number, w.title, w.description,
         w.priority, w.status, w.assigned_technician_id, t.name AS technician_name,
         w.scheduled_start, w.scheduled_end, w.site_name, w.created_by, c.name AS created_by_name,
         w.version, w.created_at, w.updated_at
  FROM work_orders w
  LEFT JOIN users t ON t.id = w.assigned_technician_id
  LEFT JOIN users c ON c.id = w.created_by
`

const SORTS: Record<ListQuery['sort'], string> = {
  created_at: 'w.created_at',
  updated_at: 'w.updated_at',
  scheduled_start: 'w.scheduled_start',
  priority: `CASE w.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`,
  status: 'w.status',
  reference: 'w.reference_number',
  title: 'w.title',
}

export function toWorkOrder(row: WorkOrderRow): WorkOrderJson {
  return {
    id: row.id,
    referenceNumber: row.reference_number,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    technicianId: row.assigned_technician_id,
    technicianName: row.technician_name,
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end).toISOString() : null,
    siteName: row.site_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function snapshot(row: WorkOrderRow) {
  return {
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    technicianId: row.assigned_technician_id,
    technicianName: row.technician_name,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    siteName: row.site_name,
    version: row.version,
  }
}

export function compileFilter(auth: AuthContext, filters: Partial<ListQuery>): { where: string; params: unknown[] } {
  const params: unknown[] = []
  const clauses: string[] = []
  const add = (clause: string, value: unknown) => {
    params.push(value)
    clauses.push(clause.replaceAll('$?', `$${params.length}`))
  }
  add('w.organisation_id = $?', auth.organisationId)
  if (auth.role === 'technician') add('w.assigned_technician_id = $?', auth.userId)
  else if (filters.technicianId) add('w.assigned_technician_id = $?', filters.technicianId)
  if (filters.status) add('w.status = $?', filters.status)
  if (filters.priority) add('w.priority = $?', filters.priority)
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    params.push(pattern)
    const ref = `$${params.length}`
    clauses.push(
      `(w.title ILIKE ${ref} ESCAPE '\\' OR w.description ILIKE ${ref} ESCAPE '\\' OR w.site_name ILIKE ${ref} ESCAPE '\\' OR w.reference_number ILIKE ${ref} ESCAPE '\\')`,
    )
  }
  return { where: clauses.join(' AND '), params }
}

function assertCanDispatch(auth: AuthContext) {
  if (auth.role === 'technician') {
    throw new AppError(403, 'FORBIDDEN', 'Only an owner or dispatcher can change work orders')
  }
}

async function lockWorkOrder(client: PoolClient, organisationId: string, id: string): Promise<WorkOrderRow | null> {
  const result = await query<WorkOrderRow>(
    `${SELECT_WORK_ORDER} WHERE w.id = $1 AND w.organisation_id = $2 FOR UPDATE OF w`,
    [id, organisationId],
    client,
  )
  return result.rows[0] ?? null
}

async function readVisible(client: PoolClient | undefined, auth: AuthContext, id: string, lock: boolean): Promise<WorkOrderRow> {
  const params: unknown[] = [id, auth.organisationId]
  let sql = `${SELECT_WORK_ORDER} WHERE w.id = $1 AND w.organisation_id = $2`
  if (auth.role === 'technician') {
    params.push(auth.userId)
    sql += ' AND w.assigned_technician_id = $3'
  }
  if (lock) sql += ' FOR UPDATE OF w'
  const result = await query<WorkOrderRow>(sql, params, client)
  const row = result.rows[0]
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
  return row
}

export async function getWorkOrder(auth: AuthContext, id: string): Promise<WorkOrderJson> {
  return toWorkOrder(await readVisible(undefined, auth, id, false))
}

export async function listWorkOrders(auth: AuthContext, filters: ListQuery) {
  const { where, params } = compileFilter(auth, filters)
  const sort = SORTS[filters.sort]
  const direction = filters.direction === 'asc' ? 'ASC' : 'DESC'
  const offset = (filters.page - 1) * filters.pageSize
  const limitRef = params.length + 1
  const offsetRef = params.length + 2
  const [rows, count] = await Promise.all([
    query<WorkOrderRow>(
      `${SELECT_WORK_ORDER} WHERE ${where}
       ORDER BY ${sort} ${direction}, w.id ${direction}
       LIMIT $${limitRef} OFFSET $${offsetRef}`,
      [...params, filters.pageSize, offset],
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total FROM work_orders w WHERE ${where}`, params),
  ])
  return {
    data: rows.rows.map(toWorkOrder),
    page: filters.page,
    pageSize: filters.pageSize,
    total: count.rows[0]?.total ?? 0,
  }
}

type ScheduleConflict = {
  id: string
  referenceNumber: string
  title: string
  scheduledStart: string
  scheduledEnd: string
}

async function findConflicts(
  client: PoolClient,
  technicianId: string,
  workOrderId: string,
  start: Date,
  end: Date,
): Promise<ScheduleConflict[]> {
  const result = await query<{
    id: string
    reference_number: string
    title: string
    scheduled_start: Date
    scheduled_end: Date
  }>(
    `SELECT id, reference_number, title, scheduled_start, scheduled_end
     FROM work_orders
     WHERE assigned_technician_id = $1
       AND id <> $2
       AND status NOT IN ('completed', 'cancelled')
       AND tstzrange(scheduled_start, scheduled_end, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [technicianId, workOrderId, start.toISOString(), end.toISOString()],
    client,
  )
  return result.rows.map((row) => ({
    id: row.id,
    referenceNumber: row.reference_number,
    title: row.title,
    scheduledStart: new Date(row.scheduled_start).toISOString(),
    scheduledEnd: new Date(row.scheduled_end).toISOString(),
  }))
}

function conflictError(conflicts: ScheduleConflict[]) {
  const first = conflicts[0]
  return new AppError(
    409,
    'SCHEDULING_CONFLICT',
    first
      ? `This technician is already assigned to ${first.referenceNumber} during that time.`
      : 'This technician is already assigned during that time.',
    { conflicts },
  )
}

async function lockTechnician(client: PoolClient, organisationId: string, technicianId: string) {
  const result = await query<{ id: string; name: string }>(
    `SELECT id, name FROM users
     WHERE id = $1 AND organisation_id = $2 AND role = 'technician' AND disabled_at IS NULL
     FOR UPDATE`,
    [technicianId, organisationId],
    client,
  )
  const row = result.rows[0]
  if (!row) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { technicianId: 'Choose an active technician in your organisation' },
    })
  }
  return row
}

async function nextReference(client: PoolClient, organisationId: string): Promise<string> {
  const result = await query<{ prefix: string; last_value: number }>(
    `UPDATE reference_counters SET last_value = last_value + 1
     WHERE organisation_id = $1
     RETURNING prefix, last_value`,
    [organisationId],
    client,
  )
  const row = result.rows[0]
  if (!row) throw new AppError(500, 'INTERNAL', 'Organisation reference counter is missing')
  return `${row.prefix}-${row.last_value}`
}

async function insertDelivery(
  client: PoolClient,
  input: {
    organisationId: string
    workOrderId: string
    technicianId: string
    start: Date
    end: Date
  },
): Promise<string | null> {
  const key = `${input.workOrderId}:${input.technicianId}:${input.start.toISOString()}:${input.end.toISOString()}`
  const result = await query<{ id: string }>(
    `INSERT INTO notification_deliveries (
       id, organisation_id, work_order_id, technician_id, idempotency_key, simulation_mode, status
     )
     SELECT $1, $2, $3, $4, $5, notification_mode, 'pending'
     FROM organisations WHERE id = $2
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [randomUUID(), input.organisationId, input.workOrderId, input.technicianId, key],
    client,
  )
  return result.rows[0]?.id ?? null
}

function assertWritable(row: WorkOrderRow) {
  if (row.status === 'completed' || row.status === 'cancelled') {
    throw new AppError(409, 'WORK_ORDER_CLOSED', 'Completed and cancelled work orders cannot be reassigned')
  }
}

function assertStatusTransition(row: WorkOrderRow, next: WorkStatus) {
  if (row.status === next) return
  if (row.status === 'completed') {
    throw new AppError(409, 'INVALID_TRANSITION', 'A completed work order cannot change status')
  }
  if (next === 'cancelled') return
  if (row.status === 'cancelled' && next !== 'open') {
    throw new AppError(409, 'INVALID_TRANSITION', 'A cancelled work order can only be reopened')
  }
  if (next === 'scheduled' && (!row.scheduled_start || !row.scheduled_end)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { status: 'Add a schedule before marking the work order scheduled' },
    })
  }
  if (next === 'in_progress' && !row.assigned_technician_id) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { status: 'Assign a technician before starting work' },
    })
  }
  const allowed: Record<WorkStatus, WorkStatus[]> = {
    open: ['scheduled', 'in_progress', 'cancelled'],
    scheduled: ['open', 'in_progress', 'completed', 'cancelled'],
    in_progress: ['scheduled', 'completed', 'cancelled'],
    completed: [],
    cancelled: ['open'],
  }
  if (!allowed[row.status].includes(next)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Cannot change status from ${row.status} to ${next}`)
  }
}

async function publishWorkOrder(auth: AuthContext, type: string, workOrder: WorkOrderJson) {
  await publish(auth.organisationId, type, {
    workOrderId: workOrder.id,
    referenceNumber: workOrder.referenceNumber,
    status: workOrder.status,
  })
}

async function afterCommit(deliveryId: string | null, auth: AuthContext, type: string, workOrder: WorkOrderJson) {
  if (deliveryId) {
    try {
      await enqueueNotification(deliveryId)
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'notification enqueue failed; the worker recovery loop will retry',
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  await publishWorkOrder(auth, type, workOrder)
}

export async function createWorkOrder(
  auth: AuthContext,
  input: z.infer<typeof createWorkOrderSchema>,
  requestId: string,
): Promise<WorkOrderJson> {
  assertCanDispatch(auth)
  const schedule = parseSchedule(input.scheduledStart, input.scheduledEnd)
  if (input.technicianId && (!schedule.start || !schedule.end)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledStart: 'A technician assignment needs a start and end' },
    })
  }
  try {
    const created = await withTransaction(async (client) => {
      if (input.technicianId) await lockTechnician(client, auth.organisationId, input.technicianId)
      const id = randomUUID()
      if (input.technicianId && schedule.start && schedule.end) {
        const conflicts = await findConflicts(client, input.technicianId, id, schedule.start, schedule.end)
        if (conflicts.length > 0) throw conflictError(conflicts)
      }
      const reference = await nextReference(client, auth.organisationId)
      const status: WorkStatus = input.technicianId ? 'scheduled' : 'open'
      const inserted = await query<WorkOrderRow>(
        `INSERT INTO work_orders (
           id, organisation_id, reference_number, title, description, priority, status,
           assigned_technician_id, scheduled_start, scheduled_end, site_name, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          id,
          auth.organisationId,
          reference,
          input.title,
          input.description,
          input.priority,
          status,
          input.technicianId ?? null,
          schedule.start?.toISOString() ?? null,
          schedule.end?.toISOString() ?? null,
          input.siteName,
          auth.userId,
        ],
        client,
      )
      const row = await lockWorkOrder(client, auth.organisationId, inserted.rows[0].id)
      if (!row) throw new AppError(500, 'INTERNAL', 'Work order disappeared during create')
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'work_order.created',
        targetType: 'work_order',
        targetId: row.id,
        after: snapshot(row),
        requestId,
      })
      let deliveryId: string | null = null
      if (input.technicianId && schedule.start && schedule.end) {
        deliveryId = await insertDelivery(client, {
          organisationId: auth.organisationId,
          workOrderId: row.id,
          technicianId: input.technicianId,
          start: schedule.start,
          end: schedule.end,
        })
        await writeAudit(client, {
          organisationId: auth.organisationId,
          actorId: auth.userId,
          actorLabel: auth.name,
          action: 'work_order.assigned',
          targetType: 'work_order',
          targetId: row.id,
          after: snapshot(row),
          requestId,
        })
      }
      return { workOrder: toWorkOrder(row), deliveryId }
    })
    await afterCommit(created.deliveryId, auth, 'work_order.created', created.workOrder)
    return created.workOrder
  } catch (error) {
    if (pgCode(error) === '23P01') {
      throw new AppError(409, 'SCHEDULING_CONFLICT', 'This technician is already assigned during that time.')
    }
    throw error
  }
}

export async function updateWorkOrder(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof patchWorkOrderSchema>,
  requestId: string,
): Promise<WorkOrderJson> {
  assertCanDispatch(auth)
  const hasField = input.title != null || input.description != null || input.priority != null || input.siteName != null || input.status != null
  if (!hasField) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { body: 'Change at least one field' },
    })
  }
  const updated = await withTransaction(async (client) => {
    const current = await lockWorkOrder(client, auth.organisationId, id)
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
    if (current.version !== input.version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'This work order was updated by someone else. Reload and try again.')
    }
    if (input.status) assertStatusTransition(current, input.status)
    if ((input.title || input.description != null || input.priority || input.siteName) && current.status === 'completed') {
      throw new AppError(409, 'WORK_ORDER_CLOSED', 'A completed work order cannot be edited')
    }
    const next: {
      title: string
      description: string
      priority: Priority
      siteName: string
      status: WorkStatus
    } = {
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      siteName: input.siteName ?? current.site_name,
      status: input.status ?? current.status,
    }
    await query(
      `UPDATE work_orders
       SET title = $3, description = $4, priority = $5, site_name = $6, status = $7, version = version + 1
       WHERE id = $1 AND organisation_id = $2 AND version = $8`,
      [id, auth.organisationId, next.title, next.description, next.priority, next.siteName, next.status, input.version],
      client,
    )
    const row = await lockWorkOrder(client, auth.organisationId, id)
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
    if (input.status && input.status !== current.status) {
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'work_order.status_changed',
        targetType: 'work_order',
        targetId: id,
        before: { status: current.status },
        after: { status: row.status },
        requestId,
      })
    }
    if (
      next.title !== current.title ||
      next.description !== current.description ||
      next.priority !== current.priority ||
      next.siteName !== current.site_name
    ) {
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'work_order.updated',
        targetType: 'work_order',
        targetId: id,
        before: snapshot(current),
        after: snapshot(row),
        requestId,
      })
    }
    return toWorkOrder(row)
  })
  await publishWorkOrder(auth, 'work_order.updated', updated)
  return updated
}

/**
 * Serialises assignments for one technician with SELECT ... FOR UPDATE on that user row.
 * The exclusion constraint is the cross-process guarantee: two API instances cannot both
 * commit overlapping ranges, because PostgreSQL checks the GiST constraint at commit.
 */
export async function assignWorkOrder(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof assignmentSchema>,
  requestId: string,
): Promise<WorkOrderJson> {
  assertCanDispatch(auth)
  const schedule = parseSchedule(input.scheduledStart, input.scheduledEnd)
  if (input.technicianId && (!schedule.start || !schedule.end)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledStart: 'A technician assignment needs a start and end' },
    })
  }
  try {
    const assigned = await withTransaction(async (client) => {
      const current = await lockWorkOrder(client, auth.organisationId, id)
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
      if (current.version !== input.version) {
        throw new AppError(409, 'VERSION_CONFLICT', 'This work order was updated by someone else. Reload and try again.')
      }
      assertWritable(current)
      if (input.technicianId && schedule.start && schedule.end) {
        await lockTechnician(client, auth.organisationId, input.technicianId)
        const conflicts = await findConflicts(client, input.technicianId, id, schedule.start, schedule.end)
        if (conflicts.length > 0) throw conflictError(conflicts)
      }
      let status = current.status
      if (input.technicianId && (status === 'open' || status === 'scheduled')) status = 'scheduled'
      if (!input.technicianId && status === 'scheduled') status = 'open'
      await query(
        `UPDATE work_orders
         SET assigned_technician_id = $3,
             scheduled_start = $4,
             scheduled_end = $5,
             status = $6,
             version = version + 1
         WHERE id = $1 AND organisation_id = $2 AND version = $7`,
        [
          id,
          auth.organisationId,
          input.technicianId,
          schedule.start?.toISOString() ?? null,
          schedule.end?.toISOString() ?? null,
          status,
          input.version,
        ],
        client,
      )
      const row = await lockWorkOrder(client, auth.organisationId, id)
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'work_order.assigned',
        targetType: 'work_order',
        targetId: id,
        before: snapshot(current),
        after: snapshot(row),
        requestId,
      })
      if (current.status !== row.status) {
        await writeAudit(client, {
          organisationId: auth.organisationId,
          actorId: auth.userId,
          actorLabel: auth.name,
          action: 'work_order.status_changed',
          targetType: 'work_order',
          targetId: id,
          before: { status: current.status },
          after: { status: row.status },
          requestId,
        })
      }
      const changed =
        current.assigned_technician_id !== row.assigned_technician_id ||
        current.scheduled_start?.toISOString() !== row.scheduled_start?.toISOString() ||
        current.scheduled_end?.toISOString() !== row.scheduled_end?.toISOString()
      let deliveryId: string | null = null
      if (changed && input.technicianId && schedule.start && schedule.end) {
        deliveryId = await insertDelivery(client, {
          organisationId: auth.organisationId,
          workOrderId: id,
          technicianId: input.technicianId,
          start: schedule.start,
          end: schedule.end,
        })
      }
      return { workOrder: toWorkOrder(row), deliveryId }
    })
    await afterCommit(assigned.deliveryId, auth, 'work_order.updated', assigned.workOrder)
    return assigned.workOrder
  } catch (error) {
    if (pgCode(error) === '23P01') {
      throw new AppError(409, 'SCHEDULING_CONFLICT', 'This technician is already assigned during that time.')
    }
    throw error
  }
}

export async function dashboard(auth: AuthContext) {
  const technicianClause = auth.role === 'technician' ? 'AND assigned_technician_id = $2' : ''
  const params: unknown[] = [auth.organisationId]
  if (auth.role === 'technician') params.push(auth.userId)
  const counts = await query<{ status: WorkStatus; total: number }>(
    `SELECT status, count(*)::int AS total
     FROM work_orders
     WHERE organisation_id = $1 ${technicianClause}
     GROUP BY status`,
    params,
  )
  const summary: Record<WorkStatus, number> = {
    open: 0,
    scheduled: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  }
  for (const row of counts.rows) summary[row.status] = row.total
  const recent = await query<WorkOrderRow>(
    `${SELECT_WORK_ORDER}
     WHERE w.organisation_id = $1 ${auth.role === 'technician' ? 'AND w.assigned_technician_id = $2' : ''}
     ORDER BY w.updated_at DESC
     LIMIT 6`,
    params,
  )
  const storage = await query<{ storage_used_bytes: number; storage_limit_bytes: number; name: string; notification_mode: string }>(
    `SELECT name, storage_used_bytes, storage_limit_bytes, notification_mode FROM organisations WHERE id = $1`,
    [auth.organisationId],
  )
  const org = storage.rows[0]
  return {
    counts: summary,
    recent: recent.rows.map(toWorkOrder),
    storage: {
      usedBytes: org?.storage_used_bytes ?? 0,
      limitBytes: org?.storage_limit_bytes ?? 0,
    },
    organisationName: org?.name ?? auth.organisationName,
    notificationMode: org?.notification_mode ?? 'success',
  }
}

export async function listActivity(auth: AuthContext, workOrderId: string) {
  await getWorkOrder(auth, workOrderId)
  const rows = await query<{
    id: string
    actor_id: string | null
    actor_label: string
    action: string
    target_type: string
    target_id: string
    before_state: unknown
    after_state: unknown
    request_id: string | null
    created_at: Date
  }>(
    `SELECT id, actor_id, actor_label, action, target_type, target_id, before_state, after_state, request_id, created_at
     FROM audit_log
     WHERE organisation_id = $1
       AND (
         (target_type = 'work_order' AND target_id = $2)
         OR (target_type = 'attachment' AND target_id IN (SELECT id FROM attachments WHERE work_order_id = $2 AND organisation_id = $1))
         OR (target_type = 'notification' AND after_state->>'workOrderId' = $2)
       )
     ORDER BY created_at ASC`,
    [auth.organisationId, workOrderId],
  )
  return {
    data: rows.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorLabel: row.actor_label,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      before: row.before_state,
      after: row.after_state,
      requestId: row.request_id,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  }
}
