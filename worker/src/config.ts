import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

const envFile = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envFile)) dotenv.config({ path: envFile })

export type WorkerConfig = {
  databaseUrl: string
  redisUrl: string
  queueName: string
  notifyAttempts: number
  notifyBackoffMs: number
  logLevel: string
}

export function getConfig(): WorkerConfig {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!redisUrl) throw new Error('REDIS_URL is required')
  return {
    databaseUrl,
    redisUrl,
    queueName: process.env.QUEUE_NAME || 'notifications',
    notifyAttempts: Number(process.env.NOTIFY_ATTEMPTS || 5),
    notifyBackoffMs: Number(process.env.NOTIFY_BACKOFF_MS || 1000),
    logLevel: process.env.LOG_LEVEL || 'info',
  }
}
