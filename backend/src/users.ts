import { randomUUID } from 'crypto'
import { z } from 'zod'
import { writeAudit } from './audit'
import { query, withTransaction } from './db/pool'
import { AppError } from './errors'
import { hashPassword } from './password'
import { pgCode } from './db/pool'
import type { AuthContext, Role } from './types'

const roles = ['owner', 'dispatcher', 'technician'] as const

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  password: z.string().min(10).max(200).regex(/[A-Za-z]/, 'Include a letter').regex(/[0-9]/, 'Include a number'),
  role: z.enum(roles),
})

export const patchUserSchema = z.object({
  role: z.enum(roles).optional(),
  disabled: z.boolean().optional(),
})

function assertOwner(auth: AuthContext) {
  if (auth.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only an owner can manage users')
}

export async function listUsers(auth: AuthContext) {
  assertOwner(auth)
  const rows = await query<{
    id: string
    name: string
    email: string
    role: Role
    disabled_at: Date | null
    created_at: Date
  }>(
    `SELECT id, name, email, role, disabled_at, created_at
     FROM users WHERE organisation_id = $1
     ORDER BY role, name`,
    [auth.organisationId],
  )
  return {
    data: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      disabled: Boolean(row.disabled_at),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  }
}

export async function listTechnicians(auth: AuthContext) {
  if (auth.role === 'technician') throw new AppError(403, 'FORBIDDEN', 'You cannot list technicians')
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM users
     WHERE organisation_id = $1 AND role = 'technician' AND disabled_at IS NULL
     ORDER BY name`,
    [auth.organisationId],
  )
  return { data: rows.rows }
}

export async function createUser(auth: AuthContext, input: z.infer<typeof createUserSchema>, requestId: string) {
  assertOwner(auth)
  const passwordHash = await hashPassword(input.password)
  try {
    return await withTransaction(async (client) => {
      const id = randomUUID()
      await query(
        `INSERT INTO users (id, organisation_id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, auth.organisationId, input.email.toLowerCase(), input.name, passwordHash, input.role],
        client,
      )
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'user.created',
        targetType: 'user',
        targetId: id,
        after: { name: input.name, email: input.email.toLowerCase(), role: input.role },
        requestId,
      })
      return { id, name: input.name, email: input.email.toLowerCase(), role: input.role, disabled: false }
    })
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError(409, 'EMAIL_IN_USE', 'That email is already in use')
    throw error
  }
}

export async function updateUser(
  auth: AuthContext,
  userId: string,
  input: z.infer<typeof patchUserSchema>,
  requestId: string,
) {
  assertOwner(auth)
  if (input.role == null && input.disabled == null) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { fields: { body: 'Change the role or disabled state' } })
  }
  return withTransaction(async (client) => {
    const existing = await query<{ id: string; role: Role; disabled_at: Date | null; name: string }>(
      `SELECT id, role, disabled_at, name FROM users WHERE id = $1 AND organisation_id = $2 FOR UPDATE`,
      [userId, auth.organisationId],
      client,
    )
    const user = existing.rows[0]
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found')
    const nextRole = input.role ?? user.role
    const nextDisabled = input.disabled ?? Boolean(user.disabled_at)
    if (userId === auth.userId && nextDisabled) {
      throw new AppError(409, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account')
    }
    const losingOwner = user.role === 'owner' && (nextRole !== 'owner' || nextDisabled)
    if (losingOwner) {
      const owners = await query<{ total: number }>(
        `SELECT count(*)::int AS total FROM users
         WHERE organisation_id = $1 AND role = 'owner' AND disabled_at IS NULL AND id <> $2`,
        [auth.organisationId, userId],
        client,
      )
      if ((owners.rows[0]?.total ?? 0) < 1) {
        throw new AppError(409, 'LAST_OWNER', 'The organisation must keep an active owner')
      }
    }
    await query(
      `UPDATE users SET role = $3, disabled_at = CASE WHEN $4::boolean THEN COALESCE(disabled_at, now()) ELSE NULL END
       WHERE id = $1 AND organisation_id = $2`,
      [userId, auth.organisationId, nextRole, nextDisabled],
      client,
    )
    if (user.role !== nextRole) {
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'user.role_changed',
        targetType: 'user',
        targetId: userId,
        before: { role: user.role },
        after: { role: nextRole },
        requestId,
      })
    }
    if (Boolean(user.disabled_at) !== nextDisabled) {
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: nextDisabled ? 'user.disabled' : 'user.enabled',
        targetType: 'user',
        targetId: userId,
        before: { disabled: Boolean(user.disabled_at) },
        after: { disabled: nextDisabled },
        requestId,
      })
    }
    return { id: userId, name: user.name, role: nextRole, disabled: nextDisabled }
  })
}
