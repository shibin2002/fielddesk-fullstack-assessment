import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, hoursFromNow, pdfBuffer, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

function multipart(filename: string, body: Buffer) {
  const boundary = '----fielddesk'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

it('checks file type, size, quota, and organisation access', async () => {
  const app = await getApp()
  const north = await createOrganisation('Northwind', 1800)
  const harbor = await createOrganisation('Harborline')
  const dispatcherUser = await createUser(north, 'dispatcher')
  const techUser = await createUser(north, 'technician')
  const otherUser = await createUser(harbor, 'dispatcher')
  const dispatcher = new Session(app)
  const technician = new Session(app)
  const other = new Session(app)
  await dispatcher.login(dispatcherUser.email)
  await technician.login(techUser.email)
  await other.login(otherUser.email)
  const created = await dispatcher.request('POST', '/api/work-orders', {
    title: 'Upload job',
    priority: 'low',
    siteName: 'Roof',
    technicianId: techUser.id,
    scheduledStart: hoursFromNow(8),
    scheduledEnd: hoursFromNow(10),
  })
  const workOrderId = created.json().id as string
  const upload = (session: Session, name: string, body: Buffer) => {
    const part = multipart(name, body)
    return session.send('POST', `/api/work-orders/${workOrderId}/attachments`, part.payload, part.headers)
  }

  const rejected = await upload(dispatcher, 'virus.exe', Buffer.from('MZ not a real image'))
  expect(rejected.statusCode).toBe(400)
  expect(rejected.json().error.code).toBe('UNSUPPORTED_FILE')

  const first = await upload(dispatcher, 'manual.pdf', pdfBuffer())
  expect(first.statusCode).toBe(200)
  expect(first.json().fileName).toBe('manual.pdf')
  expect(JSON.stringify(first.json())).not.toContain('uploads')

  const tooBig = await upload(dispatcher, 'big.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5000, 1)]))
  expect(tooBig.statusCode).toBe(413)

  const quota = await upload(dispatcher, 'second.pdf', Buffer.concat([pdfBuffer(), Buffer.alloc(2000, 2)]))
  expect(quota.statusCode).toBe(409)
  expect(quota.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED')

  const attachmentId = first.json().id as string
  const allowed = await app.inject({
    method: 'GET',
    url: `/api/attachments/${attachmentId}/content`,
    headers: { cookie: technician.cookieHeader() },
  })
  expect(allowed.statusCode).toBe(200)
  expect(allowed.headers['x-content-type-options']).toBe('nosniff')
  expect(allowed.body.startsWith('%PDF')).toBe(true)

  const denied = await app.inject({
    method: 'GET',
    url: `/api/attachments/${attachmentId}/content`,
    headers: { cookie: other.cookieHeader() },
  })
  expect(denied.statusCode).toBe(404)

  const usage = await db<{ storage_used_bytes: number }>('SELECT storage_used_bytes FROM organisations WHERE id = $1', [north])
  expect(usage.rows[0].storage_used_bytes).toBe(pdfBuffer().length)
})
