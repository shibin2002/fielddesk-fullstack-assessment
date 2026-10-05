import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { query } from './db/pool'

export async function writeAudit(
  client: PoolClient,
  entry: {
    organisationId: string
    actorId: string | null
    actorLabel: string
    action: string
    targetType: string
    targetId: string
    before?: unknown
    after?: unknown
    requestId?: string | null
  },
): Promise<void> {
  await query(
    `INSERT INTO audit_log (
       id, organisation_id, actor_id, actor_label, action, target_type, target_id,
       before_state, after_state, request_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
    [
      randomUUID(),
      entry.organisationId,
      entry.actorId,
      entry.actorLabel,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
      entry.requestId ?? null,
    ],
    client,
  )
}
