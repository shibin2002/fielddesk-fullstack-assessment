import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, hoursFromNow, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

async function fixture() {
  const app = await getApp()
  const north = await createOrganisation('Northwind')
  const harbor = await createOrganisation('Harborline')
  const northDispatcher = await createUser(north, 'dispatcher')
  const northTech = await createUser(north, 'technician')
  const northOwner = await createUser(north, 'owner')
  const harborDispatcher = await createUser(harbor, 'dispatcher')
  const dispatcher = new Session(app)
  const technician = new Session(app)
  const owner = new Session(app)
  const other = new Session(app)
  await dispatcher.login(northDispatcher.email)
  await technician.login(northTech.email)
  await owner.login(northOwner.email)
  await other.login(harborDispatcher.email)
  const created = await dispatcher.request('POST', '/api/work-orders', {
    title: 'Northwind only job',
    description: 'Secret to Harborline',
    priority: 'high',
    siteName: 'Plant A',
    technicianId: northTech.id,
    scheduledStart: hoursFromNow(24),
    scheduledEnd: hoursFromNow(26),
    organisationId: harbor,
    status: 'completed',
  })
  expect(created.statusCode).toBe(201)
  return { created: created.json(), dispatcher, technician, owner, other, north, harbor, northTech }
}

it('keeps work orders inside the authenticated organisation and role', async () => {
  const { created, technician, other, north } = await fixture()
  const stored = await db<{ organisation_id: string; status: string }>('SELECT organisation_id, status FROM work_orders WHERE id = $1', [created.id])
  expect(stored.rows[0].organisation_id).toBe(north)
  expect(stored.rows[0].status).toBe('scheduled')

  const foreign = await other.request('GET', `/api/work-orders/${created.id}`)
  expect(foreign.statusCode).toBe(404)
  const foreignPatch = await other.request('PATCH', `/api/work-orders/${created.id}`, { title: 'Stolen', version: created.version })
  expect(foreignPatch.statusCode).toBe(404)
  const foreignList = await other.request('GET', '/api/work-orders?organisationId=' + north)
  expect(foreignList.json().data).toEqual([])

  const ownList = await technician.request('GET', '/api/work-orders')
  expect(ownList.json().data.map((row: { id: string }) => row.id)).toContain(created.id)

  const hidden = await technician.request('POST', '/api/work-orders', {
    title: 'Technician should not create',
    priority: 'low',
    siteName: 'Site',
  })
  expect(hidden.statusCode).toBe(403)

  const users = await technician.request('GET', '/api/users')
  expect(users.statusCode).toBe(403)
})

it('stops a dispatcher from changing roles', async () => {
  const { dispatcher, northTech } = await fixture()
  const response = await dispatcher.request('PATCH', `/api/users/${northTech.id}`, { role: 'owner' })
  expect(response.statusCode).toBe(403)
})

it('stops an owner from removing the last active owner', async () => {
  const { owner, north } = await fixture()
  const owners = await db<{ id: string }>('SELECT id FROM users WHERE organisation_id = $1 AND role = $2', [north, 'owner'])
  const response = await owner.request('PATCH', `/api/users/${owners.rows[0].id}`, { role: 'dispatcher' })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('LAST_OWNER')
})
