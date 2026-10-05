import { createHash, randomBytes } from 'crypto'
import { SignJWT, jwtVerify } from 'jose'
import { getConfig } from './config'

export type AccessClaims = { sub: string; orgId: string }

function secretKey() {
  return new TextEncoder().encode(getConfig().jwtSecret)
}

export async function signAccessToken(userId: string, organisationId: string): Promise<string> {
  return new SignJWT({ orgId: organisationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('fielddesk')
    .setAudience('fielddesk-api')
    .setIssuedAt()
    .setExpirationTime(getConfig().accessTokenTtl)
    .sign(secretKey())
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: 'fielddesk',
    audience: 'fielddesk-api',
  })
  if (!payload.sub || typeof payload.orgId !== 'string') {
    throw new Error('invalid access token')
  }
  return { sub: payload.sub, orgId: payload.orgId }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
