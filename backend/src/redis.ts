import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { getConfig } from './config'

let redis: IORedis | null = null
let queue: Queue | null = null

export function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(getConfig().redisUrl, { maxRetriesPerRequest: null })
  }
  return redis
}

export function getQueue(): Queue {
  if (!queue) {
    const config = getConfig()
    queue = new Queue(config.queueName, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: config.notifyAttempts,
        backoff: { type: 'exponential', delay: config.notifyBackoffMs },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    })
  }
  return queue
}

export async function enqueueNotification(deliveryId: string): Promise<void> {
  try {
    await getQueue().add('notify-technician', { deliveryId }, { jobId: deliveryId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/exist|duplicate/i.test(message)) throw error
  }
}

export async function closeRedis(): Promise<void> {
  if (queue) {
    await queue.close()
    queue = null
  }
  if (redis) {
    await redis.quit()
    redis = null
  }
}
