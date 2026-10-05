import { spawn, spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Client } from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = 55432
const dataDir = path.join(root, '.local', 'pg17')
let redisServer: { stop: () => Promise<unknown> } | null = null
let startedPostgres = false
const children: ChildProcess[] = []

function postgresBin(name: string): string | null {
  const windows = path.join('C:\\Program Files\\PostgreSQL\\17\\bin', `${name}.exe`)
  if (fs.existsSync(windows)) return windows
  return null
}

function ensureCluster(): void {
  const initdb = postgresBin('initdb')
  const pgCtl = postgresBin('pg_ctl')
  if (!initdb || !pgCtl) {
    throw new Error('PostgreSQL 17 binaries were not found. Use Docker Compose instead.')
  }
  const passwordFile = path.join(root, '.local', 'pg-password.txt')
  fs.mkdirSync(path.dirname(passwordFile), { recursive: true })
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.writeFileSync(passwordFile, 'fielddesk\n')
    const created = spawnSync(initdb, ['-D', dataDir, '-U', 'fielddesk', '--pwfile', passwordFile, '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C'], { stdio: 'inherit' })
    if (created.status !== 0) throw new Error('initdb failed')
  }
  const confPath = path.join(dataDir, 'postgresql.conf')
  let conf = fs.readFileSync(confPath, 'utf8')
  conf = /^#?port\s*=.*/m.test(conf) ? conf.replace(/^#?port\s*=.*/m, `port = ${port}`) : `${conf}\nport = ${port}\n`
  conf = /^#?listen_addresses\s*=.*/m.test(conf)
    ? conf.replace(/^#?listen_addresses\s*=.*/m, "listen_addresses = '127.0.0.1'")
    : `${conf}\nlisten_addresses = '127.0.0.1'\n`
  fs.writeFileSync(confPath, conf)
  const status = spawnSync(pgCtl, ['-D', dataDir, 'status'], { stdio: 'ignore' })
  if (status.status !== 0) {
    const started = spawnSync(pgCtl, ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'inherit' })
    if (started.status !== 0) throw new Error('pg_ctl start failed')
    startedPostgres = true
  }
}

async function ensureDatabase(name: string) {
  const client = new Client({ connectionString: `postgres://fielddesk:fielddesk@127.0.0.1:${port}/postgres` })
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if ((existing.rowCount ?? 0) === 0) await client.query(`CREATE DATABASE ${name}`)
  } finally {
    await client.end()
  }
}

async function startRedis(): Promise<string> {
  const imported = await import('redis-memory-server')
  const server = new imported.RedisMemoryServer()
  redisServer = server
  const host = await server.getHost()
  const redisPort = await server.getPort()
  return `redis://${host}:${redisPort}/0`
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', shell: true })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function shutdown(code = 0): Promise<void> {
  for (const child of children) child.kill()
  if (redisServer) await redisServer.stop().catch(() => undefined)
  if (startedPostgres) {
    const pgCtl = postgresBin('pg_ctl')
    if (pgCtl) spawnSync(pgCtl, ['-D', dataDir, 'stop'], { stdio: 'inherit' })
  }
  process.exit(code)
}

async function main() {
  console.log('Starting local PostgreSQL and Redis because Docker is not required for this fallback.')
  ensureCluster()
  await ensureDatabase('fielddesk')
  const redisUrl = await startRedis()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: `postgres://fielddesk:fielddesk@127.0.0.1:${port}/fielddesk`,
    REDIS_URL: redisUrl,
    JWT_SECRET: 'dev-only-change-me-not-for-production-use-32',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'info',
    SEED_ON_START: 'false',
    UPLOAD_DIR: path.join(root, 'uploads'),
    QUEUE_NAME: 'notifications',
    NOTIFY_ATTEMPTS: '5',
    NOTIFY_BACKOFF_MS: '1000',
  }
  await run('npm', ['run', 'migrate', '-w', 'backend'], env)
  await run('npm', ['run', 'seed', '-w', 'backend'], env)
  for (const workspace of ['backend', 'worker', 'frontend']) {
    children.push(spawn('npm', ['run', 'dev', '-w', workspace], { cwd: root, env, stdio: 'inherit', shell: true }))
  }
  console.log('FieldDesk is starting. Open http://localhost:5173')
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch(async (error) => {
  console.error(error)
  await shutdown(1)
})
