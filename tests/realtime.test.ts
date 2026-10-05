import http from 'http'
import { beforeEach, expect, it } from 'vitest'
import { buildApp } from '../backend/src/app'
import { createOrganisation, createUser, hoursFromNow, resetDatabase, Session } from './helpers'

beforeEach(async () => {
  await resetDatabase()
})

it('sends work-order events only to the owning organisation', async () => {
  const app = await buildApp()
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  const openRequests: http.ClientRequest[] = []
  try {
    const north = await createOrganisation('Northwind')
    const harbor = await createOrganisation('Harborline')
    const northUser = await createUser(north, 'dispatcher')
    const harborUser = await createUser(harbor, 'dispatcher')
    const technician = await createUser(north, 'technician')
    const northSession = new Session(app)
    const harborSession = new Session(app)
    await northSession.login(northUser.email)
    await harborSession.login(harborUser.email)

    const northEvents = await openStream(`${baseUrl}/api/stream`, northSession.cookieHeader(), openRequests)
    const harborEvents = await openStream(`${baseUrl}/api/stream`, harborSession.cookieHeader(), openRequests)

    const created = await northSession.request('POST', '/api/work-orders', {
      title: 'Live dispatch',
      priority: 'high',
      siteName: 'Roof',
      technicianId: technician.id,
      scheduledStart: hoursFromNow(12),
      scheduledEnd: hoursFromNow(14),
    })
    expect(created.statusCode).toBe(201)

    const seen = await waitFor(northEvents, 4000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(seen?.workOrderId).toBe(created.json().id)
    expect(seen?.type).toBe('work_order.created')
    expect(harborEvents).toHaveLength(0)
  } finally {
    for (const request of openRequests) request.destroy()
    await app.close()
  }
})

function openStream(url: string, cookie: string, openRequests: http.ClientRequest[]): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream did not open')), 5000)
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    const request = http.get(url, { headers: { cookie, accept: 'text/event-stream' } }, (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`stream status ${response.statusCode}`))
        return
      }
      response.setEncoding('utf8')
      let buffer = ''
      let ready = false
      response.on('data', (chunk: string) => {
        buffer += chunk
        if (!ready && buffer.includes('retry:')) {
          ready = true
          clearTimeout(timer)
          resolve(events)
        }
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '))
          if (!line) continue
          events.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
        }
      })
    })
    openRequests.push(request)
    request.on('error', fail)
  })
}

async function waitFor(events: Record<string, unknown>[], timeoutMs: number) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (events.length > 0) return events[0]
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
