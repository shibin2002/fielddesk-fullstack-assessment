import { randomUUID } from 'crypto'
import { z } from 'zod'
import { writeAudit } from './audit'
import { query, withTransaction } from './db/pool'
import { AppError } from './errors'
import { publish } from './realtime'
import type { AuthContext, WorkOrderJson, WorkOrderRow, WorkStatus } from './types'
import { toWorkOrder } from './workOrders'

const SELECT_WORK_ORDER = `
  SELECT w.id, w.organisation_id, w.reference_number, w.title, w.description,
         w.priority, w.status, w.assigned_technician_id, t.name AS technician_name,
         w.scheduled_start, w.scheduled_end, w.site_name, w.created_by, c.name AS created_by_name,
         w.version, w.created_at, w.updated_at
  FROM work_orders w
  LEFT JOIN users t ON t.id = w.assigned_technician_id
  LEFT JOIN users c ON c.id = w.created_by
`

export const progressEventSchema = z.object({
  eventId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, numbers, and . _ : -'),
  workOrderId: z.string().uuid(),
  type: z.enum(['status_changed', 'note_added']),
  occurredAt: z.string().datetime(),
  payload: z.object({
    status: z.enum(['in_progress', 'completed']).optional(),
    note: z.string().trim().max(2000).optional(),
  }),
})

type ProgressInput = z.infer<typeof progressEventSchema>

function assertOccurredAt(value: string) {
  const occurred = new Date(value)
  const now = Date.now()
  if (occurred.getTime() > now + 5 * 60 * 1000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { occurredAt: 'Event time cannot be more than 5 minutes in the future' },
    })
  }
  if (occurred.getTime() < now - 30 * 24 * 60 * 60 * 1000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { occurredAt: 'Event time is older than 30 days' },
    })
  }
}

function assertPayload(input: ProgressInput) {
  if (input.type === 'status_changed' && !input.payload.status) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { 'payload.status': 'Status is required' },
    })
  }
  if (input.type === 'note_added' && !input.payload.note) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { 'payload.note': 'A note is required' },
    })
  }
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortValue(record[key])
      return acc
    }, {})
  }
  return value
}

type StoredEvent = {
  id: string
  event_id: string
  work_order_id: string
  type: 'status_changed' | 'note_added'
  occurred_at: Date
  payload: { status?: 'in_progress' | 'completed'; note?: string }
  created_at: Date
}

function presentEvent(row: StoredEvent) {
  return {
    id: row.id,
    eventId: row.event_id,
    workOrderId: row.work_order_id,
    type: row.type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function submitProgressEvent(
  auth: AuthContext,
  workOrderId: string,
  input: ProgressInput,
  requestId: string,
  options?: { failAfterInsert?: boolean },
): Promise<{ event: ReturnType<typeof presentEvent>; workOrder: WorkOrderJson; idempotentReplay: boolean; payloadMismatch: boolean }> {
  if (input.workOrderId !== workOrderId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { workOrderId: 'workOrderId does not match the URL' },
    })
  }
  assertOccurredAt(input.occurredAt)
  assertPayload(input)
  if (auth.role !== 'technician') {
    throw new AppError(403, 'FORBIDDEN', 'Only the assigned technician can submit progress events')
  }

  const result = await withTransaction(async (client) => {
    const locked = await query<WorkOrderRow>(
      `${SELECT_WORK_ORDER} WHERE w.id = $1 AND w.organisation_id = $2 FOR UPDATE OF w`,
      [workOrderId, auth.organisationId],
      client,
    )
    const current = locked.rows[0]
    if (!current || current.assigned_technician_id !== auth.userId) {
      throw new AppError(404, 'NOT_FOUND', 'Work order not found')
    }
    if (current.status === 'cancelled') {
      throw new AppError(409, 'WORK_ORDER_CLOSED', 'This work order is cancelled')
    }

    const inserted = await query<StoredEvent>(
      `INSERT INTO progress_events (
         id, organisation_id, event_id, work_order_id, actor_id, type, occurred_at, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (organisation_id, event_id) DO NOTHING
       RETURNING id, event_id, work_order_id, type, occurred_at, payload, created_at`,
      [
        randomUUID(),
        auth.organisationId,
        input.eventId,
        workOrderId,
        auth.userId,
        input.type,
        input.occurredAt,
        JSON.stringify(input.payload),
      ],
      client,
    )

    if (options?.failAfterInsert) {
      throw new Error('forced transaction failure')
    }

    if (inserted.rowCount === 0) {
      const existing = await query<StoredEvent>(
        `SELECT id, event_id, work_order_id, type, occurred_at, payload, created_at
         FROM progress_events
         WHERE organisation_id = $1 AND event_id = $2`,
        [auth.organisationId, input.eventId],
        client,
      )
      const stored = existing.rows[0]
      if (!stored) throw new AppError(409, 'EVENT_CONFLICT', 'This eventId could not be stored')
      if (stored.work_order_id !== workOrderId) {
        throw new AppError(409, 'EVENT_ID_CONFLICT', 'This eventId was already used for a different work order')
      }
      return {
        event: presentEvent(stored),
        workOrder: toWorkOrder(current),
        idempotentReplay: true,
        payloadMismatch: stable(stored.payload) !== stable(input.payload) || stored.type !== input.type,
      }
    }

    let status: WorkStatus = current.status
    if (input.type === 'status_changed' && input.payload.status) {
      const next = input.payload.status
      const legal =
        (next === 'in_progress' && (current.status === 'scheduled' || current.status === 'in_progress')) ||
        (next === 'completed' && (current.status === 'in_progress' || current.status === 'completed'))
      if (!legal) {
        throw new AppError(409, 'INVALID_TRANSITION', `Cannot change status from ${current.status} to ${next}`)
      }
      status = next
    } else if (current.status === 'completed' && input.type === 'note_added') {
      // Notes remain available after completion.
    }

    if (status !== current.status) {
      await query(
        `UPDATE work_orders SET status = $3, version = version + 1 WHERE id = $1 AND organisation_id = $2`,
        [workOrderId, auth.organisationId, status],
        client,
      )
    }

    const refreshed = await query<WorkOrderRow>(
      `${SELECT_WORK_ORDER} WHERE w.id = $1 AND w.organisation_id = $2`,
      [workOrderId, auth.organisationId],
      client,
    )
    const row = refreshed.rows[0]
    await writeAudit(client, {
      organisationId: auth.organisationId,
      actorId: auth.userId,
      actorLabel: auth.name,
      action: input.type === 'note_added' ? 'work_order.note_added' : 'work_order.status_changed',
      targetType: 'work_order',
      targetId: workOrderId,
      before: { status: current.status },
      after: { status: row.status, note: input.payload.note ?? null, eventId: input.eventId },
      requestId,
    })
    return {
      event: presentEvent(inserted.rows[0]),
      workOrder: toWorkOrder(row),
      idempotentReplay: false,
      payloadMismatch: false,
    }
  })

  if (!result.idempotentReplay) {
    await publish(auth.organisationId, 'work_order.updated', {
      workOrderId: result.workOrder.id,
      referenceNumber: result.workOrder.referenceNumber,
      status: result.workOrder.status,
    })
  }
  return result
}
