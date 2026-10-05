import { randomUUID } from 'crypto'
import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import type { Logger } from 'pino'
import { getConfig } from './config'
import { query, withTransaction } from './db'
import { PermanentFailure, sendNotification, TransientFailure } from './provider'

type DeliveryRow = {
  id: string
  organisation_id: string
  work_order_id: string
  technician_id: string
  simulation_mode: string
  status: string
  attempts: number
  updated_at: Date
  reference_number: string
}

const terminal = new Set(['succeeded', 'failed_permanent', 'failed_exhausted'])

async function audit(
  client: Parameters<typeof query>[2],
  row: DeliveryRow,
  action: string,
  after: Record<string, unknown>,
) {
  await query(
    `INSERT INTO audit_log (
       id, organisation_id, actor_id, actor_label, action, target_type, target_id, after_state
     ) VALUES (gen_random_uuid(), $1, NULL, 'notification-worker', $2, 'notification', $3, $4::jsonb)`,
    [row.organisation_id, action, row.id, JSON.stringify({ workOrderId: row.work_order_id, ...after })],
    client,
  )
}

export async function processDelivery(deliveryId: string, logger?: Logger): Promise<'skipped' | 'sent' | 'permanent'> {
  const claim = await withTransaction(async (client) => {
    const found = await query<DeliveryRow>(
      `SELECT d.id, d.organisation_id, d.work_order_id, d.technician_id, d.simulation_mode, d.status,
              d.attempts, d.updated_at, w.reference_number
       FROM notification_deliveries d
       JOIN work_orders w ON w.id = d.work_order_id
       WHERE d.id = $1
       FOR UPDATE OF d`,
      [deliveryId],
      client,
    )
    const row = found.rows[0]
    if (!row) return { kind: 'missing' as const }
    if (terminal.has(row.status)) return { kind: 'skipped' as const }
    const age = Date.now() - new Date(row.updated_at).getTime()
    if (row.status === 'sending' && age < 15_000) return { kind: 'busy' as const }
    const attempt = row.attempts + 1
    await query(
      `UPDATE notification_deliveries SET status = 'sending', attempts = $2, last_error = NULL WHERE id = $1`,
      [deliveryId, attempt],
      client,
    )
    return { kind: 'claimed' as const, row, attempt }
  })

  if (claim.kind === 'missing' || claim.kind === 'skipped') return 'skipped'
  if (claim.kind === 'busy') throw new TransientFailure('Delivery is already in progress')

  const { row, attempt } = claim
  try {
    const providerMessageId = await withTransaction((client) =>
      sendNotification(client, { deliveryId, attempt, mode: row.simulation_mode }),
    )
    await withTransaction(async (client) => {
      await query(
        `UPDATE notification_deliveries
         SET status = 'succeeded', provider_message_id = $2, last_error = NULL
         WHERE id = $1`,
        [deliveryId, providerMessageId],
        client,
      )
      await query(
        `INSERT INTO notification_attempts (id, delivery_id, attempt_number, outcome)
         VALUES (gen_random_uuid(), $1, $2, 'success')
         ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
        [deliveryId, attempt],
        client,
      )
      await audit(client, row, 'notification.succeeded', { attempt, providerMessageId, referenceNumber: row.reference_number })
    })
    await publish(row, 'succeeded')
    logger?.info({ deliveryId, attempt, providerMessageId }, 'notification sent')
    return 'sent'
  } catch (error) {
    if (error instanceof PermanentFailure) {
      await withTransaction(async (client) => {
        await query(
          `UPDATE notification_deliveries SET status = 'failed_permanent', last_error = $2 WHERE id = $1`,
          [deliveryId, error.message],
          client,
        )
        await query(
          `INSERT INTO notification_attempts (id, delivery_id, attempt_number, outcome, error_message)
           VALUES (gen_random_uuid(), $1, $2, 'permanent_failure', $3)
           ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
          [deliveryId, attempt, error.message],
          client,
        )
        await audit(client, row, 'notification.failed', { attempt, permanent: true, error: error.message, referenceNumber: row.reference_number })
      })
      await publish(row, 'failed_permanent')
      logger?.warn({ deliveryId, attempt, error: error.message }, 'notification permanently failed')
      return 'permanent'
    }
    const message = error instanceof Error ? error.message : 'Temporary failure'
    await withTransaction(async (client) => {
      await query(
        `UPDATE notification_deliveries SET status = 'retrying', last_error = $2 WHERE id = $1`,
        [deliveryId, message],
        client,
      )
      await query(
        `INSERT INTO notification_attempts (id, delivery_id, attempt_number, outcome, error_message)
         VALUES (gen_random_uuid(), $1, $2, 'transient_failure', $3)
         ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
        [deliveryId, attempt, message],
        client,
      )
      await audit(client, row, 'notification.retrying', { attempt, error: message, referenceNumber: row.reference_number })
    })
    await publish(row, 'retrying')
    logger?.warn({ deliveryId, attempt, error: message }, 'notification temporarily failed')
    throw error instanceof TransientFailure ? error : new TransientFailure(message)
  }
}

async function publish(row: DeliveryRow, status: string) {
  const redis = new IORedis(getConfig().redisUrl, { maxRetriesPerRequest: null })
  try {
    const payload = JSON.stringify({
      id: randomUUID(),
      type: 'notification.updated',
      at: new Date().toISOString(),
      workOrderId: row.work_order_id,
      referenceNumber: row.reference_number,
      status,
    })
    await redis.publish(`fielddesk:org:${row.organisation_id}`, payload)
  } finally {
    await redis.quit()
  }
}

export async function markExhausted(deliveryId: string, message: string): Promise<void> {
  await query(
    `UPDATE notification_deliveries
     SET status = 'failed_exhausted', last_error = $2
     WHERE id = $1 AND status IN ('pending', 'sending', 'retrying')`,
    [deliveryId, message],
  )
}

export function createNotificationWorker(logger: Logger) {
  const config = getConfig()
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
  const worker = new Worker(
    config.queueName,
    async (job: Job<{ deliveryId: string }>) => processDelivery(job.data.deliveryId, logger),
    { connection, concurrency: 4 },
  )
  worker.on('failed', (job, error) => {
    if (!job) return
    const max = job.opts.attempts ?? config.notifyAttempts
    logger.error({ deliveryId: job.data.deliveryId, attemptsMade: job.attemptsMade, max, error: error.message }, 'notification job failed')
    if (job.attemptsMade >= max && !(error instanceof PermanentFailure)) {
      void markExhausted(job.data.deliveryId, error.message).catch((markError) => {
        logger.error({ err: markError }, 'could not record exhausted notification')
      })
    }
  })
  return { worker, connection }
}

export async function recoverStuckDeliveries(queue: Queue): Promise<number> {
  const stuck = await query<{ id: string }>(
    `SELECT id FROM notification_deliveries
     WHERE status IN ('pending', 'retrying', 'sending')
       AND updated_at < now() - interval '15 seconds'
     ORDER BY updated_at
     LIMIT 100`,
  )
  for (const row of stuck.rows) {
    try {
      await queue.add('notify-technician', { deliveryId: row.id }, { jobId: row.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/exist|duplicate/i.test(message)) throw error
    }
  }
  return stuck.rows.length
}
