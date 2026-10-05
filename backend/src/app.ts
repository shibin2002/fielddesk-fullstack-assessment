import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'
import { addAttachment, listAttachments, openAttachment } from './attachments'
import { authenticate, login, loginSchema, logout, refreshSession, requireCsrf } from './authService'
import { getConfig } from './config'
import { query } from './db/pool'
import { AppError, parseInput, sendError } from './errors'
import { submitProgressEvent, progressEventSchema } from './events'
import { isUuid } from './files'
import { writeAudit } from './audit'
import { withTransaction } from './db/pool'
import { getRedis } from './redis'
import { addClient, replayAfter, startRealtime } from './realtime'
import { streamWorkOrderCsv } from './reports'
import {
  assignWorkOrder,
  assignmentSchema,
  createWorkOrder,
  createWorkOrderSchema,
  dashboard,
  getWorkOrder,
  listActivity,
  listQuerySchema,
  listWorkOrders,
  patchWorkOrderSchema,
  updateWorkOrder,
} from './workOrders'
import { createUser, createUserSchema, listTechnicians, listUsers, patchUserSchema, updateUser } from './users'

function requireAuth(request: FastifyRequest) {
  if (!request.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  return request.auth
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\w.\- ()]+/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

async function listNotifications(request: FastifyRequest) {
  const auth = requireAuth(request)
  const technicianId = auth.role === 'technician' ? auth.userId : null
  const deliveries = await query<{
    id: string
    work_order_id: string
    reference_number: string
    technician_id: string
    technician_name: string
    status: string
    attempts: number
    last_error: string | null
    provider_message_id: string | null
    simulation_mode: string
    created_at: Date
    updated_at: Date
  }>(
    `SELECT d.id, d.work_order_id, w.reference_number, d.technician_id, t.name AS technician_name,
            d.status, d.attempts, d.last_error, d.provider_message_id, d.simulation_mode, d.created_at, d.updated_at
     FROM notification_deliveries d
     JOIN work_orders w ON w.id = d.work_order_id
     JOIN users t ON t.id = d.technician_id
     WHERE d.organisation_id = $1
       AND ($2::uuid IS NULL OR d.technician_id = $2)
     ORDER BY d.created_at DESC
     LIMIT 30`,
    [auth.organisationId, technicianId],
  )
  const ids = deliveries.rows.map((row) => row.id)
  const attempts = ids.length
    ? await query<{
        delivery_id: string
        attempt_number: number
        outcome: string
        error_message: string | null
        created_at: Date
      }>(
        `SELECT delivery_id, attempt_number, outcome, error_message, created_at
         FROM notification_attempts
         WHERE delivery_id = ANY($1::uuid[])
         ORDER BY attempt_number`,
        [ids],
      )
    : { rows: [] }
  return {
    data: deliveries.rows.map((row) => ({
      id: row.id,
      workOrderId: row.work_order_id,
      referenceNumber: row.reference_number,
      technicianId: row.technician_id,
      technicianName: row.technician_name,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      providerMessageId: row.provider_message_id,
      simulationMode: row.simulation_mode,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      attemptLog: attempts.rows
        .filter((attempt) => attempt.delivery_id === row.id)
        .map((attempt) => ({
          attemptNumber: attempt.attempt_number,
          outcome: attempt.outcome,
          errorMessage: attempt.error_message,
          createdAt: new Date(attempt.created_at).toISOString(),
        })),
    })),
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig()
  const app = Fastify({
    forceCloseConnections: true,
    trustProxy: config.trustProxy,
    requestTimeout: 0,
    bodyLimit: 1_000_000,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      if (typeof incoming === 'string' && /^[A-Za-z0-9._:-]{8,80}$/.test(incoming)) return incoming
      return randomUUID()
    },
    requestIdHeader: 'x-request-id',
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    },
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, { origin: config.corsOrigins, credentials: true })
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } })
  await app.register(rateLimit, { global: false, redis: getRedis().duplicate() })
  await startRealtime()

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return sendError(reply, request, error)
    const known = error as { statusCode?: number; code?: string }
    if (known.code === 'FST_REQ_FILE_TOO_LARGE' || known.statusCode === 413) {
      return sendError(reply, request, new AppError(413, 'FILE_TOO_LARGE', 'The file is larger than the upload limit'))
    }
    if (known.code === 'FST_ERR_CTP_INVALID_JSON') {
      return sendError(reply, request, new AppError(400, 'VALIDATION_ERROR', 'Request body must be JSON'))
    }
    request.log.error({ err: error }, 'unhandled error')
    return sendError(reply, request, new AppError(500, 'INTERNAL', 'Something went wrong'))
  })

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, request, new AppError(404, 'NOT_FOUND', 'Resource not found'))
  })

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async (request, reply) => readiness(request, reply))
  app.get('/api/health', async () => ({ status: 'ok' }))
  app.get('/api/ready', async (request, reply) => readiness(request, reply))

  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      requireCsrf(request)
    })

    api.post('/auth/login', {
      config: { rateLimit: { max: config.loginRateMax, timeWindow: config.loginRateWindow } },
    }, async (request, reply) => {
      const body = parseInput(loginSchema, request.body)
      return login(body.email, body.password, reply)
    })

    api.post('/auth/refresh', async (request, reply) => refreshSession(request, reply))
    api.post('/auth/logout', async (request, reply) => {
      await logout(request, reply)
      return { ok: true }
    })

    await api.register(async (secure) => {
      secure.addHook('preHandler', async (request) => {
        await authenticate(request)
      })

      secure.get('/auth/me', async (request) => ({
        user: {
          id: requireAuth(request).userId,
          email: requireAuth(request).email,
          name: requireAuth(request).name,
          role: requireAuth(request).role,
          organisationId: requireAuth(request).organisationId,
          organisationName: requireAuth(request).organisationName,
        },
      }))

      secure.get('/dashboard', async (request) => dashboard(requireAuth(request)))
      secure.get('/technicians', async (request) => listTechnicians(requireAuth(request)))
      secure.get('/users', async (request) => listUsers(requireAuth(request)))
      secure.post('/users', async (request) => {
        const body = parseInput(createUserSchema, request.body)
        return createUser(requireAuth(request), body, request.id)
      })
      secure.patch('/users/:id', async (request) => {
        const params = request.params as { id: string }
        if (!isUuid(params.id)) throw new AppError(404, 'NOT_FOUND', 'User not found')
        const body = parseInput(patchUserSchema, request.body)
        return updateUser(requireAuth(request), params.id, body, request.id)
      })

      secure.get('/organisation', async (request) => {
        const auth = requireAuth(request)
        const result = await query<{
          id: string
          name: string
          storage_used_bytes: number
          storage_limit_bytes: number
          notification_mode: string
        }>(
          `SELECT id, name, storage_used_bytes, storage_limit_bytes, notification_mode FROM organisations WHERE id = $1`,
          [auth.organisationId],
        )
        const org = result.rows[0]
        return {
          id: org.id,
          name: org.name,
          storageUsedBytes: org.storage_used_bytes,
          storageLimitBytes: org.storage_limit_bytes,
          notificationMode: org.notification_mode,
        }
      })

      secure.put('/organisation/notification-mode', async (request) => {
        const auth = requireAuth(request)
        if (auth.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only an owner can change notification simulation')
        const body = parseInput(z.object({
          mode: z.enum(['success', 'transient', 'permanent', 'transient_twice']),
        }), request.body)
        await withTransaction(async (client) => {
          await query(`UPDATE organisations SET notification_mode = $2 WHERE id = $1`, [auth.organisationId, body.mode], client)
          await writeAudit(client, {
            organisationId: auth.organisationId,
            actorId: auth.userId,
            actorLabel: auth.name,
            action: 'organisation.notification_mode_changed',
            targetType: 'organisation',
            targetId: auth.organisationId,
            after: { mode: body.mode },
            requestId: request.id,
          })
        })
        return { notificationMode: body.mode }
      })

      secure.get('/notifications', async (request) => listNotifications(request))

      secure.get('/work-orders/export', async (request, reply) => {
        const filters = parseInput(listQuerySchema.partial(), request.query)
        await streamWorkOrderCsv(reply, requireAuth(request), filters)
      })

      secure.get('/work-orders', async (request) => {
        const filters = parseInput(listQuerySchema, request.query)
        return listWorkOrders(requireAuth(request), filters)
      })

      secure.post('/work-orders', async (request, reply) => {
        const body = parseInput(createWorkOrderSchema, request.body)
        const created = await createWorkOrder(requireAuth(request), body, request.id)
        return reply.code(201).send(created)
      })

      secure.get('/work-orders/:id', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        return getWorkOrder(requireAuth(request), id)
      })

      secure.patch('/work-orders/:id', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        const body = parseInput(patchWorkOrderSchema, request.body)
        return updateWorkOrder(requireAuth(request), id, body, request.id)
      })

      secure.post('/work-orders/:id/assignment', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        const body = parseInput(assignmentSchema, request.body)
        return assignWorkOrder(requireAuth(request), id, body, request.id)
      })

      secure.get('/work-orders/:id/activity', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        return listActivity(requireAuth(request), id)
      })

      secure.post('/work-orders/:id/events', {
        config: {
          rateLimit: {
            max: config.eventRateMax,
            timeWindow: config.eventRateWindow,
            keyGenerator: (req: FastifyRequest) => req.auth?.userId ?? req.ip,
          },
        },
      }, async (request, reply) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        const body = parseInput(progressEventSchema, request.body)
        const failAfterInsert = process.env.NODE_ENV === 'test' && request.headers['x-test-failpoint'] === 'after-event-insert'
        const result = await submitProgressEvent(requireAuth(request), id, body, request.id, { failAfterInsert })
        return reply.status(result.idempotentReplay ? 200 : 201).send(result)
      })

      secure.get('/work-orders/:id/attachments', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        return listAttachments(requireAuth(request), id)
      })

      secure.post('/work-orders/:id/attachments', async (request) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
        const file = await request.file()
        if (!file) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { fields: { file: 'Choose a file' } })
        }
        const buffer = await file.toBuffer()
        return addAttachment(requireAuth(request), id, { buffer, fileName: file.filename }, request.id)
      })

      secure.get('/attachments/:id/content', async (request, reply) => {
        const { id } = request.params as { id: string }
        if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
        const opened = await openAttachment(requireAuth(request), id)
        reply.header('Content-Type', opened.contentType)
        reply.header('Content-Disposition', contentDisposition(opened.fileName))
        reply.header('X-Content-Type-Options', 'nosniff')
        reply.header('Cache-Control', 'private, no-store')
        return reply.send(opened.stream)
      })

      secure.get('/stream', async (request, reply) => {
        const auth = requireAuth(request)
        const lastEventId = typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined
        const missed = await replayAfter(auth.organisationId, lastEventId).catch(() => [])
        reply.hijack()
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Request-Id': request.id,
        })
        reply.raw.write('retry: 4000\n\n')
        reply.raw.flushHeaders?.()
        for (const event of missed) {
          reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        const remove = addClient(auth.organisationId, reply.raw)
        const ping = setInterval(() => {
          if (!reply.raw.destroyed) reply.raw.write(': ping\n\n')
        }, 15_000)
        request.raw.on('close', () => {
          clearInterval(ping)
          remove()
        })
      })
    })
  }, { prefix: '/api' })

  app.addHook('onClose', async () => {
    // The process entrypoint closes Redis after Fastify stops accepting requests.
  })

  return app
}

async function readiness(request: FastifyRequest, reply: FastifyReply) {
  try {
    await query('SELECT 1')
    const pong = await getRedis().ping()
    if (pong !== 'PONG') throw new Error('redis unavailable')
    return { status: 'ready' }
  } catch {
    return sendError(reply, request, new AppError(503, 'NOT_READY', 'Dependency unavailable'))
  }
}
