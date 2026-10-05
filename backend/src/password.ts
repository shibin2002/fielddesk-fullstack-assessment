import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto'

const COST = 16384
const BLOCK_SIZE = 8
const PARALLEL = 1
const KEY_LENGTH = 32

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { cost: number; blockSize: number; parallelization: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = (await scryptAsync(password, salt, KEY_LENGTH, {
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelization: PARALLEL,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLEL}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const cost = Number(parts[1])
  const blockSize = Number(parts[2])
  const parallelization = Number(parts[3])
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) return false
  const salt = Buffer.from(parts[4], 'base64url')
  const expected = Buffer.from(parts[5], 'base64url')
  if (salt.length === 0 || expected.length === 0) return false
  const actual = (await scryptAsync(password, salt, expected.length, {
    cost,
    blockSize,
    parallelization,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
