import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge } from '../components'
import { formatRange, formatBytes, greeting } from '../format'
import type { WorkOrder, WorkStatus } from '../types'

type Dashboard = {
  counts: Record<WorkStatus, number>
  recent: WorkOrder[]
  storage: { usedBytes: number; limitBytes: number }
}

const order: WorkStatus[] = ['open', 'scheduled', 'in_progress', 'completed', 'cancelled']

export function DashboardPage() {
  const { user } = useAuth()
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/api/dashboard'),
  })

  if (dashboard.isLoading) return <p className="boot">Loading the board…</p>
  if (dashboard.isError || !dashboard.data || !user) return <p className="boot">The dashboard could not be loaded.</p>
  const used = dashboard.data.storage.limitBytes
    ? Math.min(100, Math.round((dashboard.data.storage.usedBytes / dashboard.data.storage.limitBytes) * 100))
    : 0

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{user.organisationName}</p>
          <h1>{greeting(user.name)}</h1>
        </div>
        {user.role === 'technician' ? null : <Link className="primary button-link" to="/work-orders/new">New work order</Link>}
      </header>
      <section className="stats">
        {order.map((status) => (
          <Link key={status} to={`/work-orders?status=${status}`} className="stat">
            <span>{status.replaceAll('_', ' ')}</span>
            <strong>{dashboard.data?.counts[status] ?? 0}</strong>
          </Link>
        ))}
      </section>
      <section className="split">
        <div className="card">
          <h2>Recent work</h2>
          {dashboard.data.recent.length === 0 ? <p className="empty">No work orders yet.</p> : (
            <ul className="recent">
              {dashboard.data.recent.map((order) => (
                <li key={order.id}>
                  <Link to={`/work-orders/${order.id}`}>
                    <b>{order.referenceNumber}</b>
                    <span>{order.title}</span>
                  </Link>
                  <StatusBadge status={order.status} />
                  <PriorityBadge priority={order.priority} />
                  <em>{formatRange(order.scheduledStart, order.scheduledEnd)}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Storage</h2>
          <p>{formatBytes(dashboard.data.storage.usedBytes)} of {formatBytes(dashboard.data.storage.limitBytes)}</p>
          <div className="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={100} role="meter">
            <span style={{ width: `${used}%` }} />
          </div>
          <p className="hint">Files are checked on the server. The original filename is kept only as a label.</p>
        </div>
      </section>
    </div>
  )
}
