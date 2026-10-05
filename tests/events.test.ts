import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, hoursFromNow, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

async function assignedJob() {
  const app = await getApp()
  const org = await createOrganisation('Northwind')
  const dispatcherUser = await createUser(org, 'dispatcher')
  const techUser = await createUser(org, 'technician')
  const otherTech = await createUser(org, 'technician')
  const dispatcher = new Session(app)
  const technician = new Session(app)
  const stranger = new Session(app)
  await dispatcher.login(dispatcherUser.email)
  await technician.login(techUser.email)
  await stranger.login(otherTech.email)
  const created = await dispatcher.request('POST', '/api/work-orders', {
    title: 'Progress job',
    description: 'Start the pump',
    priority: 'medium',
    siteName: 'Pump room',
    technicianId: techUser.id,
    scheduledStart: hoursFromNow(5),
    scheduledEnd: hoursFromNow(7),
  })
  expect(created.statusCode).toBe(201)
  return { technician, stranger, dispatcher, workOrder: created.json() as { id: string; status: string } }
}

function eventBody(workOrderId: string, eventId: string, status = 'in_progress') {
  return {
    eventId,
    workOrderId,
    type: 'status_changed',
    occurredAt: new Date().toISOString(),
    payload: { status, note: 'Work started' },
  }
}

it('applies a progress event once when the same event arrives twice at the same time', async () => {
  const { technician, workOrder } = await assignedJob()
  const body = eventBody(workOrder.id, 'evt-concurrent')
  const [first, second] = await Promise.all([
    technician.request('POST', `/api/work-orders/${workOrder.id}/events`, body),
    technician.request('POST', `/api/work-orders/${workOrder.id}/events`, body),
  ])
  expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201])
  const replays = [first.json(), second.json()].filter((row) => row.idempotentReplay)
  expect(replays).toHaveLength(1)
  const stored = await db<{ total: number }>('SELECT count(*)::int AS total FROM progress_events')
  expect(stored.rows[0].total).toBe(1)
  const status = await db<{ status: string }>('SELECT status FROM work_orders WHERE id = $1', [workOrder.id])
  expect(status.rows[0].status).toBe('in_progress')

  const mismatch = await technician.request('POST', `/api/work-orders/${workOrder.id}/events`, {
    ...body,
    payload: { status: 'completed', note: 'Different payload' },
  })
  expect(mismatch.statusCode).toBe(200)
  expect(mismatch.json().payloadMismatch).toBe(true)
  const still = await db<{ status: string }>('SELECT status FROM work_orders WHERE id = $1', [workOrder.id])
  expect(still.rows[0].status).toBe('in_progress')
})

it('rejects invalid events and rolls back when a later write fails', async () => {
  const { technician, stranger, dispatcher, workOrder } = await assignedJob()
  const invalid = await technician.request('POST', `/api/work-orders/${workOrder.id}/events`, {
    eventId: 'evt-bad',
    workOrderId: workOrder.id,
    type: 'status_changed',
    occurredAt: new Date().toISOString(),
    payload: { note: 'missing status' },
  })
  expect(invalid.statusCode).toBe(400)
  const forbidden = await stranger.request('POST', `/api/work-orders/${workOrder.id}/events`, eventBody(workOrder.id, 'evt-other'))
  expect(forbidden.statusCode).toBe(404)
  const dispatcherAttempt = await dispatcher.request('POST', `/api/work-orders/${workOrder.id}/events`, eventBody(workOrder.id, 'evt-disp'))
  expect(dispatcherAttempt.statusCode).toBe(403)

  const failed = await technician.request(
    'POST',
    `/api/work-orders/${workOrder.id}/events`,
    eventBody(workOrder.id, 'evt-rollback'),
    { 'x-test-failpoint': 'after-event-insert' },
  )
  expect(failed.statusCode).toBe(500)
  const events = await db<{ total: number }>('SELECT count(*)::int AS total FROM progress_events')
  expect(events.rows[0].total).toBe(0)
  const status = await db<{ status: string }>('SELECT status FROM work_orders WHERE id = $1', [workOrder.id])
  expect(status.rows[0].status).toBe('scheduled')
})

it('does not allow audit history to be edited', async () => {
  await assignedJob()
  await expect(db(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/immutable_row/)
})
