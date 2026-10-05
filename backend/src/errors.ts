import type { FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError, type ZodTypeAny } from 'zod'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function parseInput<T extends ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: fieldErrors(parsed.error),
    })
  }
  return parsed.data
}

function fieldErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'body'
    if (!fields[key]) fields[key] = issue.message
  }
  return fields
}

export function sendError(reply: FastifyReply, request: FastifyRequest, error: AppError) {
  return reply.status(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
      requestId: request.id,
    },
  })
}
