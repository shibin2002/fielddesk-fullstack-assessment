import fs from 'fs'
import path from 'path'
import { getConfig } from './config'
import { AppError } from './errors'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export type DetectedFile = { contentType: string; extension: string }

export function detectFile(buffer: Buffer): DetectedFile | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' }
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length >= png.length && buffer.subarray(0, png.length).equals(png)) {
    return { contentType: 'image/png', extension: 'png' }
  }
  const gif = buffer.subarray(0, Math.min(6, buffer.length)).toString('ascii')
  if (gif === 'GIF87a' || gif === 'GIF89a') return { contentType: 'image/gif', extension: 'gif' }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' }
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1')
  if (head.includes('%PDF-')) return { contentType: 'application/pdf', extension: 'pdf' }
  return null
}

export function safeDisplayName(original: string, extension: string): string {
  const base = path.basename(original || '').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  if (!base || base === '_') return `attachment.${extension}`
  return base
}

export function attachmentFilePath(organisationId: string, attachmentId: string): string {
  if (!isUuid(organisationId) || !isUuid(attachmentId)) {
    throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
  }
  const root = path.resolve(getConfig().uploadDir)
  const full = path.resolve(root, organisationId, attachmentId)
  const relative = path.relative(root, full)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
  }
  return full
}

export async function writeUpload(organisationId: string, attachmentId: string, body: Buffer): Promise<void> {
  const full = attachmentFilePath(organisationId, attachmentId)
  await fs.promises.mkdir(path.dirname(full), { recursive: true })
  const temporary = `${full}.partial`
  await fs.promises.writeFile(temporary, body)
  await fs.promises.rename(temporary, full)
}

export async function removeUpload(organisationId: string, attachmentId: string): Promise<void> {
  const full = attachmentFilePath(organisationId, attachmentId)
  await fs.promises.rm(full, { force: true })
  await fs.promises.rm(`${full}.partial`, { force: true })
}
