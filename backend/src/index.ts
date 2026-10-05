import { buildApp } from './app'
import { getConfig } from './config'
import { migrate } from './db/migrate'
import { getPool } from './db/pool'
import { seed } from './db/seed'
import { closeRedis } from './redis'

async function main() {
  const config = getConfig()
  await migrate()
  if (process.env.SEED_ON_START === 'true') await seed()
  const app = await buildApp()
  await app.listen({ port: config.port, host: config.host })

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await closeRedis()
      await getPool().end()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
