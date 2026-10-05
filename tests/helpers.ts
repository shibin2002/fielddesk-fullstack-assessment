import './setup'
import { randomUUID } from 'crypto'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { buildApp } from '../backend/src/app'
import { query } from '../backend/src/db/pool'
import { hashPassword } from '../backend/src/password'
import { getRedis } from '../backend/src/redis'

export const password = 'FieldDesk-Assess-1'

let app: FastifyInstance | null = null
let passwordHash: string | null = null

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp()
  return app
}

export async function resetDatabase(): Promise<void> {
  const current = await query<{ name: string }>('SELECT current_database() AS name')
  if (current.rows[0]?.name !== 'fielddesk_test') {
    throw new Error(`Refusing to reset database ${current.rows[0]?.name ?? 'unknown'}`)
  }
  await query(`
    TRUNCATE TABLE
      notification_attempts,
      provider_receipts,
      notification_deliveries,
      progress_events,
      attachments,
      audit_log,
      refresh_sessions,
      work_orders,
      reference_counters,
      users,
      organisations
    RESTART IDENTITY CASCADE
  `)
  if (process.env.FIELDDESK_TEST_REDIS !== '1') throw new Error('Refusing to flush Redis')
  await getRedis().flushdb()
}

async function hashedPassword(): Promise<string> {
  passwordHash ??= await hashPassword(password)
  return passwordHash
}

export async function createOrganisation(name: string, storageLimit = 50 * 1024 * 1024): Promise<string> {
  const id = randomUUID()
  await query(
    `INSERT INTO organisations (id, name, storage_limit_bytes) VALUES ($1, $2, $3)`,
    [id, name, storageLimit],
  )
  await query(
    `INSERT INTO reference_counters (organisation_id, prefix, last_value) VALUES ($1, $2, 1000)`,
    [id, name.slice(0, 2).toUpperCase()],
  )
  return id
}

export async function createUser(organisationId: string, role: 'owner' | 'dispatcher' | 'technician', email?: string) {
  const id = randomUUID()
  const address = email ?? `${role}.${id.slice(0, 8)}@example.test`
  await query(
    `INSERT INTO users (id, organisation_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, organisationId, address, `${role} user`, await hashedPassword(), role],
  )
  return { id, email: address, role, name: `${role} user` }
}

export class Session {
  private jar = new Map<string, string>()

  constructor(private app: FastifyInstance) {}

  private absorb(setCookie: string | string[] | number | undefined) {
    const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : []
    for (const cookie of list) {
      const [pair] = cookie.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!value || /max-age=0/i.test(cookie)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }

  async request(method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await this.app.inject({
      method,
      url,
      payload: body as InjectOptions['payload'],
      headers: {
        cookie: this.cookieHeader(),
        'x-fielddesk-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    })
    this.absorb(response.headers['set-cookie'])
    return response
  }

  async send(method: InjectOptions['method'], url: string, payload: Buffer, headers: Record<string, string>) {
    const response = await this.app.inject({
      method,
      url,
      payload,
      headers: {
        cookie: this.cookieHeader(),
        'x-fielddesk-request': '1',
        ...headers,
      },
    })
    this.absorb(response.headers['set-cookie'])
    return response
  }

  async login(email: string) {
    const response = await this.request('POST', '/api/auth/login', { email, password })
    if (response.statusCode !== 200) {
      throw new Error(`Login failed for ${email}: ${response.body}`)
    }
    return response
  }
}

export function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

export async function db<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return query<T>(text, params)
}
