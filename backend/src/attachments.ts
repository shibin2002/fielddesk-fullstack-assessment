import { randomUUID } from 'crypto'
import fs from 'fs'
import { writeAudit } from './audit'
import { query, withTransaction } from './db/pool'
import { AppError } from './errors'
import { attachmentFilePath, detectFile, removeUpload, safeDisplayName, writeUpload } from './files'
import { getConfig } from './config'
import { publish } from './realtime'
import type { AuthContext } from './types'

async function assertVisibleWorkOrder(auth: AuthContext, workOrderId: string, client?: Parameters<typeof query>[2]) {
  const params: unknown[] = [workOrderId, auth.organisationId]
  let sql = `SELECT id, reference_number, assigned_technician_id FROM work_orders WHERE id = $1 AND organisation_id = $2`
  if (auth.role === 'technician') {
    params.push(auth.userId)
    sql += ' AND assigned_technician_id = $3'
  }
  if (client) sql += ' FOR UPDATE'
  const result = await query<{ id: string; reference_number: string }>(sql, params, client)
  const row = result.rows[0]
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Work order not found')
  return row
}

export async function listAttachments(auth: AuthContext, workOrderId: string) {
  await assertVisibleWorkOrder(auth, workOrderId)
  const rows = await query<{
    id: string
    file_name: string
    content_type: string
    size_bytes: number
    created_at: Date
  }>(
    `SELECT id, file_name, content_type, size_bytes, created_at
     FROM attachments
     WHERE work_order_id = $1 AND organisation_id = $2
     ORDER BY created_at ASC`,
    [workOrderId, auth.organisationId],
  )
  return {
    data: rows.rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  }
}

export async function addAttachment(
  auth: AuthContext,
  workOrderId: string,
  file: { buffer: Buffer; fileName: string },
  requestId: string,
) {
  if (auth.role !== 'owner' && auth.role !== 'dispatcher' && auth.role !== 'technician') {
    throw new AppError(403, 'FORBIDDEN', 'You cannot upload attachments')
  }
  if (file.buffer.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { fields: { file: 'The file is empty' } })
  }
  if (file.buffer.length > getConfig().maxUploadBytes) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The file is larger than the upload limit')
  }
  const detected = detectFile(file.buffer)
  if (!detected) {
    throw new AppError(400, 'UNSUPPORTED_FILE', 'Upload a PDF or an image (PNG, JPEG, GIF, or WEBP)')
  }
  const attachmentId = randomUUID()
  const storageKey = `${auth.organisationId}/${attachmentId}`
  const fileName = safeDisplayName(file.fileName, detected.extension)
  try {
    await writeUpload(auth.organisationId, attachmentId, file.buffer)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'attachment write failed before the database commit',
      error: error instanceof Error ? error.message : String(error),
    }))
    throw new AppError(500, 'STORAGE_WRITE_FAILED', 'Could not store the file')
  }

  try {
    const saved = await withTransaction(async (client) => {
      const workOrder = await assertVisibleWorkOrder(auth, workOrderId, client)
      const quota = await query<{ storage_used_bytes: number }>(
        `UPDATE organisations
         SET storage_used_bytes = storage_used_bytes + $2
         WHERE id = $1 AND storage_used_bytes + $2 <= storage_limit_bytes
         RETURNING storage_used_bytes`,
        [auth.organisationId, file.buffer.length],
        client,
      )
      if (quota.rowCount === 0) {
        throw new AppError(409, 'STORAGE_QUOTA_EXCEEDED', 'This organisation has reached its storage limit')
      }
      await query(
        `INSERT INTO attachments (
           id, organisation_id, work_order_id, uploaded_by, storage_key, file_name, content_type, size_bytes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [attachmentId, auth.organisationId, workOrderId, auth.userId, storageKey, fileName, detected.contentType, file.buffer.length],
        client,
      )
      await writeAudit(client, {
        organisationId: auth.organisationId,
        actorId: auth.userId,
        actorLabel: auth.name,
        action: 'attachment.added',
        targetType: 'attachment',
        targetId: attachmentId,
        after: { workOrderId, fileName, contentType: detected.contentType, sizeBytes: file.buffer.length, referenceNumber: workOrder.reference_number },
        requestId,
      })
      return {
        id: attachmentId,
        fileName,
        contentType: detected.contentType,
        sizeBytes: file.buffer.length,
      }
    })
    await publish(auth.organisationId, 'attachment.added', { workOrderId, attachmentId: saved.id })
    return saved
  } catch (error) {
    await removeUpload(auth.organisationId, attachmentId)
    throw error
  }
}

export async function openAttachment(auth: AuthContext, attachmentId: string) {
  const found = await query<{
    id: string
    organisation_id: string
    work_order_id: string
    file_name: string
    content_type: string
    assigned_technician_id: string | null
  }>(
    `SELECT a.id, a.organisation_id, a.work_order_id, a.file_name, a.content_type, w.assigned_technician_id
     FROM attachments a
     JOIN work_orders w ON w.id = a.work_order_id
     WHERE a.id = $1 AND a.organisation_id = $2`,
    [attachmentId, auth.organisationId],
  )
  const row = found.rows[0]
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
  if (auth.role === 'technician' && row.assigned_technician_id !== auth.userId) {
    throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
  }
  const fullPath = attachmentFilePath(row.organisation_id, row.id)
  if (!fs.existsSync(fullPath)) throw new AppError(404, 'NOT_FOUND', 'Attachment not found')
  return {
    stream: fs.createReadStream(fullPath),
    fileName: row.file_name,
    contentType: row.content_type,
  }
}
