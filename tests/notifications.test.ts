import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import pino from 'pino'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, hoursFromNow, resetDatabase, Session } from './helpers'
import { createNotificationWorker, processDelivery } from '../worker/src/processor'

const logger = pino({ level: 'silent' })

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

async function assign(mode: string) {
  const app = await getApp()
  const org = await createOrganisation('Northwind')
  await db(`UPDATE organisations SET notification_mode = $2 WHERE id = $1`, [org, mode])
  const dispatcherUser = await createUser(org, 'dispatcher')
  const tech = await createUser(org, 'technician')
  const session = new Session(app)
  await session.login(dispatcherUser.email)
  const created = await session.request('POST', '/api/work-orders', {
    title: `${mode} notification`,
    priority: 'high',
    siteName: 'Plant',
    technicianId: tech.id,
    scheduledStart: hoursFromNow(30),
    scheduledEnd: hoursFromNow(32),
  })
  expect(created.statusCode).toBe(201)
  const delivery = await db<{ id: string }>('SELECT id FROM notification_deliveries WHERE work_order_id = $1', [created.json().id])
  return delivery.rows[0].id
}

it('sends one notification and ignores a duplicate delivery', async () => {
  const deliveryId = await assign('success')
  expect(await processDelivery(deliveryId, logger)).toBe('sent')
  expect(await processDelivery(deliveryId, logger)).toBe('skipped')
  const receipts = await db<{ total: number }>('SELECT count(*)::int AS total FROM provider_receipts WHERE delivery_id = $1', [deliveryId])
  const row = await db<{ status: string; attempts: number }>('SELECT status, attempts FROM notification_deliveries WHERE id = $1', [deliveryId])
  expect(receipts.rows[0].total).toBe(1)
  expect(row.rows[0]).toMatchObject({ status: 'succeeded', attempts: 1 })
  const audits = await db<{ total: number }>(
    `SELECT count(*)::int AS total FROM audit_log WHERE action = 'notification.succeeded' AND target_id = $1`,
    [deliveryId],
  )
  expect(audits.rows[0].total).toBe(1)
})

it('stops on a permanent provider failure', async () => {
  const deliveryId = await assign('permanent')
  expect(await processDelivery(deliveryId, logger)).toBe('permanent')
  expect(await processDelivery(deliveryId, logger)).toBe('skipped')
  const row = await db<{ status: string; attempts: number }>('SELECT status, attempts FROM notification_deliveries WHERE id = $1', [deliveryId])
  const receipts = await db<{ total: number }>('SELECT count(*)::int AS total FROM provider_receipts WHERE delivery_id = $1', [deliveryId])
  expect(row.rows[0]).toMatchObject({ status: 'failed_permanent', attempts: 1 })
  expect(receipts.rows[0].total).toBe(0)
})

it('retries a temporary provider failure and still delivers once', async () => {
  const deliveryId = await assign('transient_twice')
  const connection = new IORedis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null })
  const queue = new Queue(process.env.QUEUE_NAME || 'notifications-test', { connection })
  const { worker, connection: workerConnection } = createNotificationWorker(logger)
  try {
    const status = await waitForStatus(deliveryId, 'succeeded')
    expect(status.attempts).toBeGreaterThanOrEqual(3)
    const receipts = await db<{ total: number }>('SELECT count(*)::int AS total FROM provider_receipts WHERE delivery_id = $1', [deliveryId])
    const transient = await db<{ total: number }>(
      `SELECT count(*)::int AS total FROM notification_attempts WHERE delivery_id = $1 AND outcome = 'transient_failure'`,
      [deliveryId],
    )
    expect(receipts.rows[0].total).toBe(1)
    expect(transient.rows[0].total).toBeGreaterThanOrEqual(2)
  } finally {
    await worker.close()
    await queue.close()
    await workerConnection.quit()
    await connection.quit()
  }
})

async function waitForStatus(deliveryId: string, status: string) {
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    const row = await db<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM notification_deliveries WHERE id = $1',
      [deliveryId],
    )
    if (row.rows[0]?.status === status) return row.rows[0]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const latest = await db('SELECT status, attempts, last_error FROM notification_deliveries WHERE id = $1', [deliveryId])
  throw new Error(`delivery did not reach ${status}: ${JSON.stringify(latest.rows[0])}`)
}
