import { randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import { getRedis } from './redis'

export type LiveEvent = {
  id: string
  type: string
  at: string
  [key: string]: unknown
}

const clients = new Map<string, Set<ServerResponse>>()
let subscriberStarted = false

export async function startRealtime(): Promise<void> {
  if (subscriberStarted) return
  const subscriber = getRedis().duplicate()
  await subscriber.psubscribe('fielddesk:org:*')
  subscriber.on('pmessage', (_pattern, channel: string, message: string) => {
    const orgId = channel.slice('fielddesk:org:'.length)
    const listeners = clients.get(orgId)
    if (!listeners || listeners.size === 0) return
    let eventId: string = randomUUID()
    try {
      const parsed = JSON.parse(message) as { id?: string }
      if (parsed.id) eventId = parsed.id
    } catch {
      return
    }
    const frame = `id: ${eventId}\ndata: ${message}\n\n`
    for (const response of listeners) {
      if (response.writableEnded || response.destroyed) {
        listeners.delete(response)
        continue
      }
      response.write(frame)
    }
  })
  subscriberStarted = true
}

export function addClient(organisationId: string, response: ServerResponse): () => void {
  let listeners = clients.get(organisationId)
  if (!listeners) {
    listeners = new Set()
    clients.set(organisationId, listeners)
  }
  listeners.add(response)
  return () => {
    listeners?.delete(response)
    if (listeners && listeners.size === 0) clients.delete(organisationId)
  }
}

export async function publish(organisationId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const event: LiveEvent = { id: randomUUID(), type, at: new Date().toISOString(), ...data }
  const payload = JSON.stringify(event)
  try {
    const redis = getRedis()
    await redis.publish(`fielddesk:org:${organisationId}`, payload)
    const key = `fielddesk:recent:${organisationId}`
    await redis.lpush(key, payload)
    await redis.ltrim(key, 0, 49)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'warn',
      msg: 'realtime publish failed; clients will catch up on reconnect',
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

export async function replayAfter(organisationId: string, lastEventId: string | undefined): Promise<LiveEvent[]> {
  if (!lastEventId) return []
  const raw = await getRedis().lrange(`fielddesk:recent:${organisationId}`, 0, 49)
  const events = raw.map((item) => JSON.parse(item) as LiveEvent).reverse()
  const index = events.findIndex((event) => event.id === lastEventId)
  if (index === -1) {
    return [{ id: randomUUID(), type: 'resync', at: new Date().toISOString() }]
  }
  return events.slice(index + 1)
}
