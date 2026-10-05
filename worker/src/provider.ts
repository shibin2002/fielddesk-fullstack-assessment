import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'

export class TransientFailure extends Error {
  readonly temporary = true
}

export class PermanentFailure extends Error {
  readonly permanent = true
}

/**
 * Controllable stand-in for an external notification provider.
 * Success is recorded once per delivery so a retry cannot send a second message.
 */
export async function sendNotification(
  client: PoolClient,
  input: { deliveryId: string; attempt: number; mode: string },
): Promise<string> {
  if (input.mode === 'permanent') {
    throw new PermanentFailure('Provider rejected the destination')
  }
  if (input.mode === 'transient' || (input.mode === 'transient_twice' && input.attempt <= 2)) {
    throw new TransientFailure('Provider timed out')
  }
  const messageId = `mock_${randomUUID()}`
  const inserted = await client.query<{ provider_message_id: string }>(
    `INSERT INTO provider_receipts (delivery_id, provider_message_id)
     VALUES ($1, $2)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING provider_message_id`,
    [input.deliveryId, messageId],
  )
  if ((inserted.rowCount ?? 0) > 0) return inserted.rows[0].provider_message_id
  const existing = await client.query<{ provider_message_id: string }>(
    `SELECT provider_message_id FROM provider_receipts WHERE delivery_id = $1`,
    [input.deliveryId],
  )
  return existing.rows[0].provider_message_id
}
