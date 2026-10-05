import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import pino from 'pino'
import { getConfig } from './config'
import { getPool } from './db'
import { createNotificationWorker, recoverStuckDeliveries } from './processor'

async function main() {
  const config = getConfig()
  const logger = pino({ level: config.logLevel })
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
  const queue = new Queue(config.queueName, {
    connection,
    defaultJobOptions: {
      attempts: config.notifyAttempts,
      backoff: { type: 'exponential', delay: config.notifyBackoffMs },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  })
  const { worker, connection: workerConnection } = createNotificationWorker(logger)
  const timer = setInterval(() => {
    void recoverStuckDeliveries(queue).catch((error) => {
      logger.error({ err: error }, 'notification recovery failed')
    })
  }, 10_000)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    logger.info({ signal }, 'worker shutting down')
    clearInterval(timer)
    await worker.close()
    await queue.close()
    await workerConnection.quit()
    await connection.quit()
    await getPool().end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  logger.info({ queue: config.queueName }, 'notification worker started')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
