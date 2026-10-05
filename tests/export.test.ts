import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, getApp, hoursFromNow, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

it('exports only the caller organisation and neutralises formulas', async () => {
  const app = await getApp()
  const north = await createOrganisation('Northwind')
  const harbor = await createOrganisation('Harborline')
  const northDispatcher = await createUser(north, 'dispatcher')
  const northTech = await createUser(north, 'technician')
  const harborDispatcher = await createUser(harbor, 'dispatcher')
  const dispatcher = new Session(app)
  const technician = new Session(app)
  const other = new Session(app)
  await dispatcher.login(northDispatcher.email)
  await technician.login(northTech.email)
  await other.login(harborDispatcher.email)

  const secret = await dispatcher.request('POST', '/api/work-orders', {
    title: '=1+1',
    description: 'Do not leak',
    priority: 'urgent',
    siteName: 'Vault',
    technicianId: northTech.id,
    scheduledStart: hoursFromNow(3),
    scheduledEnd: hoursFromNow(4),
  })
  expect(secret.statusCode).toBe(201)
  await dispatcher.request('POST', '/api/work-orders', {
    title: 'Unassigned northwind job',
    priority: 'low',
    siteName: 'Yard',
  })
  await other.request('POST', '/api/work-orders', {
    title: 'Harborline generator',
    priority: 'high',
    siteName: 'Pier',
  })

  const exported = await dispatcher.request('GET', '/api/work-orders/export?organisationId=' + harbor)
  expect(exported.statusCode).toBe(200)
  expect(exported.headers['content-type']).toContain('text/csv')
  expect(exported.body).toContain("'=1+1")
  expect(exported.body).not.toContain('Harborline generator')

  const otherExport = await other.request('GET', '/api/work-orders/export')
  expect(otherExport.body).not.toContain('=1+1')
  expect(otherExport.body).not.toContain('Vault')
  expect(otherExport.body).toContain('Harborline generator')

  const techExport = await technician.request('GET', '/api/work-orders/export')
  expect(techExport.body).toContain("'=1+1")
  expect(techExport.body).not.toContain('Unassigned northwind job')
})
