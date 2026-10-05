import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Client } from 'pg'

const repoRoot = path.resolve(__dirname, '..')
const runtimePath = path.resolve(__dirname, '.runtime-env.json')
const localDir = path.resolve(repoRoot, '.local', 'pg17')
const port = 55432
let startedPostgres = false
let redisServer: { stop: () => Promise<unknown> } | null = null

function postgresBin(name: string): string | null {
  const windows = path.join('C:\\Program Files\\PostgreSQL\\17\\bin', `${name}.exe`)
  if (fs.existsSync(windows)) return windows
  return null
}

function ensureLocalPostgres(): string {
  const initdb = postgresBin('initdb')
  const pgCtl = postgresBin('pg_ctl')
  if (!initdb || !pgCtl) throw new Error('Local PostgreSQL binaries were not found')
  const passwordFile = path.join(repoRoot, '.local', 'pg-password.txt')
  fs.mkdirSync(path.dirname(passwordFile), { recursive: true })
  if (!fs.existsSync(path.join(localDir, 'PG_VERSION'))) {
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.writeFileSync(passwordFile, 'fielddesk\n')
    const created = spawnSync(initdb, ['-D', localDir, '-U', 'fielddesk', '--pwfile', passwordFile, '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C'], {
      stdio: 'inherit',
    })
    if (created.status !== 0) throw new Error('initdb failed')
  }
  const confPath = path.join(localDir, 'postgresql.conf')
  let conf = fs.readFileSync(confPath, 'utf8')
  conf = /^#?port\s*=.*/m.test(conf) ? conf.replace(/^#?port\s*=.*/m, `port = ${port}`) : `${conf}\nport = ${port}\n`
  conf = /^#?listen_addresses\s*=.*/m.test(conf)
    ? conf.replace(/^#?listen_addresses\s*=.*/m, "listen_addresses = '127.0.0.1'")
    : `${conf}\nlisten_addresses = '127.0.0.1'\n`
  fs.writeFileSync(confPath, conf)
  const status = spawnSync(pgCtl, ['-D', localDir, 'status'], { stdio: 'ignore' })
  if (status.status !== 0) {
    const logFile = path.join(localDir, 'server.log')
    const started = spawnSync(pgCtl, ['-D', localDir, '-l', logFile, 'start'], { stdio: 'inherit' })
    if (started.status !== 0) throw new Error('pg_ctl start failed')
    startedPostgres = true
  }
  return `postgres://fielddesk:fielddesk@127.0.0.1:${port}/postgres`
}

async function ensureDatabase(adminUrl: string, database: string) {
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE ${database}`)
  } finally {
    await client.end()
  }
}

async function startEmbeddedPostgres(): Promise<string> {
  const imported = await import('embedded-postgres')
  const EmbeddedPostgres = imported.default
  const databaseDir = path.join(repoRoot, '.local', 'embedded-pg')
  fs.mkdirSync(databaseDir, { recursive: true })
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: 'fielddesk',
    password: 'fielddesk',
    port,
    persistent: true,
  })
  try {
    await embedded.initialise()
  } catch {
    // The cluster was created on a previous run.
  }
  await embedded.start()
  startedPostgres = false
  try {
    await embedded.createDatabase('fielddesk_test')
  } catch {
    // Already created.
  }
  return `postgres://fielddesk:fielddesk@127.0.0.1:${port}/fielddesk_test`
}

async function startRedis(): Promise<string> {
  const imported = await import('redis-memory-server')
  const RedisMemoryServer = imported.RedisMemoryServer
  const server = new RedisMemoryServer()
  redisServer = server
  const host = await server.getHost()
  const redisPort = await server.getPort()
  return `redis://${host}:${redisPort}/0`
}

export async function setup() {
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-only-jwt-secret-32-characters-min',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    UPLOAD_DIR: path.join(os.tmpdir(), 'fielddesk-test-uploads'),
    MAX_UPLOAD_BYTES: '4096',
    LOGIN_RATE_MAX: '1000',
    EVENT_RATE_MAX: '1000',
    NOTIFY_ATTEMPTS: '5',
    NOTIFY_BACKOFF_MS: '50',
    QUEUE_NAME: 'notifications-test',
    FIELDDESK_TEST_REDIS: '1',
    SEED_ON_START: 'false',
  }

  if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname.endsWith('/fielddesk_test')) {
    env.DATABASE_URL = process.env.DATABASE_URL
  } else if (postgresBin('initdb')) {
    const adminUrl = ensureLocalPostgres()
    await ensureDatabase(adminUrl, 'fielddesk_test')
    env.DATABASE_URL = `postgres://fielddesk:fielddesk@127.0.0.1:${port}/fielddesk_test`
  } else {
    env.DATABASE_URL = await startEmbeddedPostgres()
  }

  if (process.env.REDIS_URL && new URL(process.env.REDIS_URL).pathname === '/15') {
    env.REDIS_URL = process.env.REDIS_URL
    redisServer = null
  } else if (!process.env.REDIS_URL) {
    env.REDIS_URL = await startRedis()
  } else {
    throw new Error('Set REDIS_URL to a dedicated test database ending in /15, or leave it unset')
  }

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true })
  fs.writeFileSync(runtimePath, JSON.stringify(env, null, 2))
  for (const [key, value] of Object.entries(env)) process.env[key] = value

  const { migrate } = await import('../backend/src/db/migrate')
  const { getPool } = await import('../backend/src/db/pool')
  await migrate()
  await getPool().end()
}

export async function teardown() {
  if (redisServer) await redisServer.stop()
  if (!startedPostgres) return
  const pgCtl = postgresBin('pg_ctl')
  if (!pgCtl) return
  spawnSync(pgCtl, ['-D', localDir, 'stop'], { stdio: 'inherit' })
}
