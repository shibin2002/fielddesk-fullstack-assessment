import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, hoursFromNow, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

async function dispatchPair() {
  const app = await getApp()
  const org = await createOrganisation('Northwind')
  const dispatcherUser = await createUser(org, 'dispatcher')
  const tech = await createUser(org, 'technician')
  const session = new Session(app)
  await session.login(dispatcherUser.email)
  return { session, tech, org }
}

async function openOrder(session: Session, title: string) {
  const response = await session.request('POST', '/api/work-orders', {
    title,
    description: 'Scheduling test',
    priority: 'high',
    siteName: 'Plant',
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; version: number }
}

it('rejects an impossible schedule window', async () => {
  const { session, tech } = await dispatchPair()
  const response = await session.request('POST', '/api/work-orders', {
    title: 'Backwards',
    priority: 'low',
    siteName: 'Yard',
    technicianId: tech.id,
    scheduledStart: hoursFromNow(10),
    scheduledEnd: hoursFromNow(8),
  })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('VALIDATION_ERROR')
})

it('rejects overlapping assignments under concurrent requests and keeps the exclusion constraint', async () => {
  const { session, tech } = await dispatchPair()
  const first = await openOrder(session, 'First job')
  const second = await openOrder(session, 'Second job')
  const body = {
    technicianId: tech.id,
    scheduledStart: hoursFromNow(48),
    scheduledEnd: hoursFromNow(50),
    version: 1,
  }
  const [left, right] = await Promise.all([
    session.request('POST', `/api/work-orders/${first.id}/assignment`, { ...body, version: first.version }),
    session.request('POST', `/api/work-orders/${second.id}/assignment`, { ...body, version: second.version }),
  ])
  const statuses = [left.statusCode, right.statusCode].sort()
  expect(statuses).toEqual([200, 409])
  const conflict = left.statusCode === 409 ? left : right
  expect(conflict.json().error.code).toBe('SCHEDULING_CONFLICT')
  const assigned = await db<{ total: number }>(
    `SELECT count(*)::int AS total FROM work_orders WHERE assigned_technician_id = $1`,
    [tech.id],
  )
  expect(assigned.rows[0].total).toBe(1)

  const adjacent = await openOrder(session, 'Adjacent job')
  const adjacentResult = await session.request('POST', `/api/work-orders/${adjacent.id}/assignment`, {
    technicianId: tech.id,
    scheduledStart: hoursFromNow(50),
    scheduledEnd: hoursFromNow(52),
    version: adjacent.version,
  })
  expect(adjacentResult.statusCode).toBe(200)

  const owner = await db<{ id: string }>('SELECT created_by AS id FROM work_orders LIMIT 1')
  await expect(db(
    `INSERT INTO work_orders (
       id, organisation_id, reference_number, title, description, priority, status,
       assigned_technician_id, scheduled_start, scheduled_end, site_name, created_by
     )
     SELECT gen_random_uuid(), organisation_id, 'NW-overlap', 'Raw overlap', '', 'high', 'scheduled',
            assigned_technician_id, scheduled_start, scheduled_end, 'Plant', $1
     FROM work_orders WHERE assigned_technician_id = $2 LIMIT 1`,
    [owner.rows[0].id, tech.id],
  )).rejects.toMatchObject({ code: '23P01' })
})
