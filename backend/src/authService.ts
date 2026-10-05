import { randomUUID } from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getConfig } from './config'
import { query } from './db/pool'
import { AppError } from './errors'
import { hashPassword, verifyPassword } from './password'
import { hashToken, newRefreshToken, signAccessToken, verifyAccessToken } from './tokens'
import type { AuthContext, Role } from './types'

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
})

type UserRow = {
  id: string
  organisation_id: string
  email: string
  name: string
  role: Role
  password_hash: string
  disabled_at: Date | null
  organisation_name: string
}

let dummyHash: Promise<string> | null = null

function dummyPasswordHash() {
  dummyHash ??= hashPassword('dummy-password-not-used')
  return dummyHash
}

export function cookieBase() {
  const config = getConfig()
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
  }
}

export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  const config = getConfig()
  const base = cookieBase()
  reply.setCookie('fd_access', accessToken, { ...base, maxAge: config.accessTokenSeconds })
  reply.setCookie('fd_refresh', refreshToken, { ...base, maxAge: config.refreshTokenDays * 24 * 60 * 60 })
}

export function clearAuthCookies(reply: FastifyReply) {
  const base = cookieBase()
  reply.clearCookie('fd_access', base)
  reply.clearCookie('fd_refresh', base)
}

async function issueSession(user: UserRow, reply: FastifyReply) {
  const refresh = newRefreshToken()
  await query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [randomUUID(), user.id, hashToken(refresh), String(getConfig().refreshTokenDays)],
  )
  const access = await signAccessToken(user.id, user.organisation_id)
  setAuthCookies(reply, access, refresh)
  return publicUser(user)
}

function publicUser(user: UserRow | AuthContext & { organisationName: string }) {
  if ('organisation_id' in user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organisationId: user.organisation_id,
      organisationName: user.organisation_name,
    }
  }
  return {
    id: user.userId,
    email: user.email,
    name: user.name,
    role: user.role,
    organisationId: user.organisationId,
    organisationName: user.organisationName,
  }
}

export async function login(email: string, password: string, reply: FastifyReply) {
  const found = await query<UserRow>(
    `SELECT u.id, u.organisation_id, u.email, u.name, u.role, u.password_hash, u.disabled_at, o.name AS organisation_name
     FROM users u JOIN organisations o ON o.id = u.organisation_id
     WHERE lower(u.email) = lower($1)`,
    [email],
  )
  const user = found.rows[0]
  const hash = user?.password_hash ?? (await dummyPasswordHash())
  const matches = await verifyPassword(password, hash)
  if (!user || !matches || user.disabled_at) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }
  const sessionUser = await issueSession(user, reply)
  return { user: sessionUser }
}

export async function refreshSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies.fd_refresh
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  const tokenHash = hashToken(token)
  const found = await query<{
    id: string
    user_id: string
    expires_at: Date
    revoked_at: Date | null
  }>(
    `SELECT id, user_id, expires_at, revoked_at FROM refresh_sessions WHERE token_hash = $1`,
    [tokenHash],
  )
  const session = found.rows[0]
  if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  if (session.revoked_at) {
    await query(`UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [session.user_id])
    clearAuthCookies(reply)
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  }
  const userResult = await query<UserRow>(
    `SELECT u.id, u.organisation_id, u.email, u.name, u.role, u.password_hash, u.disabled_at, o.name AS organisation_name
     FROM users u JOIN organisations o ON o.id = u.organisation_id
     WHERE u.id = $1`,
    [session.user_id],
  )
  const user = userResult.rows[0]
  if (!user || user.disabled_at) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  await query(`UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [session.id])
  const sessionUser = await issueSession(user, reply)
  return { user: sessionUser }
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies.fd_refresh
  if (token) {
    await query(`UPDATE refresh_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)])
  }
  clearAuthCookies(reply)
}

export async function authenticate(request: FastifyRequest) {
  const header = request.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  const token = bearer || request.cookies.fd_access
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  let claims: { sub: string; orgId: string }
  try {
    claims = await verifyAccessToken(token)
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  }
  const result = await query<UserRow>(
    `SELECT u.id, u.organisation_id, u.email, u.name, u.role, u.password_hash, u.disabled_at, o.name AS organisation_name
     FROM users u JOIN organisations o ON o.id = u.organisation_id
     WHERE u.id = $1`,
    [claims.sub],
  )
  const user = result.rows[0]
  if (!user || user.disabled_at || user.organisation_id !== claims.orgId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required')
  }
  const auth: AuthContext = {
    userId: user.id,
    organisationId: user.organisation_id,
    role: user.role,
    email: user.email,
    name: user.name,
    organisationName: user.organisation_name,
  }
  request.auth = auth
  return auth
}

export function requireCsrf(request: FastifyRequest) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
  if (request.headers.authorization?.startsWith('Bearer ')) return
  if (request.headers['x-fielddesk-request'] !== '1') {
    throw new AppError(403, 'CSRF_REJECTED', 'Missing request header')
  }
}
