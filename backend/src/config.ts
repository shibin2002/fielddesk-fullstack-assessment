import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

const envFile = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile })
}

export type AppConfig = {
  nodeEnv: string
  port: number
  host: string
  databaseUrl: string
  redisUrl: string
  jwtSecret: string
  accessTokenTtl: string
  accessTokenSeconds: number
  refreshTokenDays: number
  cookieSecure: boolean
  trustProxy: boolean
  corsOrigins: string[]
  logLevel: string
  maxUploadBytes: number
  uploadDir: string
  loginRateMax: number
  loginRateWindow: string
  eventRateMax: number
  eventRateWindow: string
  notifyAttempts: number
  notifyBackoffMs: number
  queueName: string
  defaultStorageLimitBytes: number
}

let cached: AppConfig | null = null

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function flag(name: string, fallback = false): boolean {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return value === 'true' || value === '1'
}

function ttlSeconds(value: string, fallback: number): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim())
  if (!match) return fallback
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400
  return amount * multiplier
}

export function getConfig(): AppConfig {
  if (cached) return cached
  const jwtSecret = required('JWT_SECRET')
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters')
  }
  const accessTokenTtl = process.env.ACCESS_TOKEN_TTL || '15m'
  const uploadDir = process.env.UPLOAD_DIR || 'uploads'
  cached = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    jwtSecret,
    accessTokenTtl,
    accessTokenSeconds: ttlSeconds(accessTokenTtl, 15 * 60),
    refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 7),
    cookieSecure: flag('COOKIE_SECURE'),
    trustProxy: flag('TRUST_PROXY'),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
    logLevel: process.env.LOG_LEVEL || 'info',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024),
    uploadDir: path.isAbsolute(uploadDir) ? uploadDir : path.resolve(process.cwd(), uploadDir),
    loginRateMax: Number(process.env.LOGIN_RATE_MAX || 10),
    loginRateWindow: process.env.LOGIN_RATE_WINDOW || '1 minute',
    eventRateMax: Number(process.env.EVENT_RATE_MAX || 30),
    eventRateWindow: process.env.EVENT_RATE_WINDOW || '1 minute',
    notifyAttempts: Number(process.env.NOTIFY_ATTEMPTS || 5),
    notifyBackoffMs: Number(process.env.NOTIFY_BACKOFF_MS || 1000),
    queueName: process.env.QUEUE_NAME || 'notifications',
    defaultStorageLimitBytes: Number(process.env.DEFAULT_STORAGE_LIMIT_BYTES || 50 * 1024 * 1024),
  }
  return cached
}
