import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { Banner } from '../components'
import { formatBytes, formatWhen } from '../format'
import type { NotificationMode } from '../types'

type Organisation = {
  name: string
  storageUsedBytes: number
  storageLimitBytes: number
  notificationMode: NotificationMode
}

type Delivery = {
  id: string
  referenceNumber: string
  technicianName: string
  status: string
  attempts: number
  lastError: string | null
  providerMessageId: string | null
  updatedAt: string
  attemptLog: { attemptNumber: number; outcome: string; errorMessage: string | null }[]
}

const modes: { id: NotificationMode; title: string; copy: string }[] = [
  { id: 'success', title: 'Success', copy: 'The mock provider accepts the notification on the first try.' },
  { id: 'transient_twice', title: 'Temporary, then success', copy: 'The first two attempts time out. The third succeeds. Useful for watching retries.' },
  { id: 'transient', title: 'Always temporary', copy: 'Every attempt times out until retries are exhausted.' },
  { id: 'permanent', title: 'Permanent failure', copy: 'The provider rejects the destination and the worker stops immediately.' },
]

export function SettingsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const organisation = useQuery({ queryKey: ['organisation'], queryFn: () => api<Organisation>('/api/organisation') })
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ data: Delivery[] }>('/api/notifications') })
  const save = useMutation({
    mutationFn: (mode: NotificationMode) => api('/api/organisation/notification-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
    onSuccess: () => queryClient.invalidateQueries(),
  })
  if (user && user.role !== 'owner') return <Navigate to="/" replace />
  if (organisation.isLoading) return <p className="boot">Loading settings…</p>
  if (!organisation.data) return <Banner>Settings could not be loaded.</Banner>
  const used = Math.min(100, Math.round((organisation.data.storageUsedBytes / organisation.data.storageLimitBytes) * 100))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{organisation.data.name}</p>
          <h1>Settings</h1>
        </div>
      </header>
      <section className="card">
        <h2>Storage</h2>
        <p>{formatBytes(organisation.data.storageUsedBytes)} of {formatBytes(organisation.data.storageLimitBytes)} used.</p>
        <div className="meter" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${used}%` }} /></div>
      </section>
      <section className="card">
        <h2>Notification simulation</h2>
        <p className="hint">Assign a technician after choosing a mode. The worker records each attempt on the delivery below. This does not call a real provider.</p>
        <div className="modes">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={organisation.data?.notificationMode === mode.id ? 'mode selected' : 'mode'}
              onClick={() => save.mutate(mode.id)}
            >
              <b>{mode.title}</b>
              <span>{mode.copy}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Recent deliveries</h2>
        {notifications.data && notifications.data.data.length === 0 ? <p className="empty">No notifications yet. Assign a work order to enqueue one.</p> : null}
        <ul className="deliveries">
          {notifications.data?.data.map((delivery) => (
            <li key={delivery.id}>
              <div>
                <b>{delivery.referenceNumber}</b>
                <span>{delivery.technicianName} · {delivery.status.replaceAll('_', ' ')} · {formatWhen(delivery.updatedAt)}</span>
                {delivery.lastError ? <small>{delivery.lastError}</small> : null}
                {delivery.providerMessageId ? <small>Provider id {delivery.providerMessageId}</small> : null}
              </div>
              <ol>
                {delivery.attemptLog.map((attempt) => (
                  <li key={attempt.attemptNumber}>Attempt {attempt.attemptNumber}: {attempt.outcome}{attempt.errorMessage ? ` (${attempt.errorMessage})` : ''}</li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
