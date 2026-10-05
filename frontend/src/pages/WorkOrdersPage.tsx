import { useQuery } from '@tanstack/react-query'
import { FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, downloadCsv } from '../api'
import { useAuth } from '../auth'
import { Banner, PriorityBadge, StatusBadge } from '../components'
import { formatRange } from '../format'
import type { Priority, WorkOrder, WorkStatus } from '../types'

type ListResponse = { data: WorkOrder[]; page: number; pageSize: number; total: number }
type Technicians = { data: { id: string; name: string }[] }

export function WorkOrdersPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [draft, setDraft] = useState(params.get('q') ?? '')
  const [exportError, setExportError] = useState('')
  const page = Number(params.get('page') ?? '1')
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    priority: params.get('priority') ?? '',
    technicianId: params.get('technicianId') ?? '',
    sort: params.get('sort') ?? 'created_at',
    direction: params.get('direction') ?? 'desc',
    page,
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, String(value))
  }
  const list = useQuery({
    queryKey: ['work-orders', query.toString()],
    queryFn: () => api<ListResponse>(`/api/work-orders?${query.toString()}`),
  })
  const technicians = useQuery({
    queryKey: ['technicians'],
    queryFn: () => api<Technicians>('/api/technicians'),
    enabled: user?.role !== 'technician',
  })

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params)
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value)
      else merged.delete(key)
    }
    if (!('page' in next)) merged.delete('page')
    setParams(merged)
  }

  function onSearch(event: FormEvent) {
    event.preventDefault()
    update({ q: draft.trim() })
  }

  const total = list.data?.total ?? 0
  const pageSize = list.data?.pageSize ?? 20
  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Schedule</p>
          <h1>Work orders</h1>
        </div>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={() => void downloadCsv(query.toString()).catch((error: Error) => setExportError(error.message))}>Export CSV</button>
          {user?.role === 'technician' ? null : <Link className="primary button-link" to="/work-orders/new">New work order</Link>}
        </div>
      </header>
      {exportError ? <Banner>{exportError}</Banner> : null}
      <form className="filters" onSubmit={onSearch}>
        <input aria-label="Search work orders" placeholder="Search title, site, or reference" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <select aria-label="Status" value={filters.status} onChange={(event) => update({ status: event.target.value })}>
          <option value="">All statuses</option>
          {['open', 'scheduled', 'in_progress', 'completed', 'cancelled'].map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}
        </select>
        <select aria-label="Priority" value={filters.priority} onChange={(event) => update({ priority: event.target.value })}>
          <option value="">All priorities</option>
          {['urgent', 'high', 'medium', 'low'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
        </select>
        {user?.role === 'technician' ? null : (
          <select aria-label="Technician" value={filters.technicianId} onChange={(event) => update({ technicianId: event.target.value })}>
            <option value="">All technicians</option>
            {technicians.data?.data.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </select>
        )}
        <select aria-label="Sort" value={`${filters.sort}:${filters.direction}`} onChange={(event) => {
          const [sort, direction] = event.target.value.split(':')
          update({ sort, direction })
        }}>
          <option value="created_at:desc">Newest</option>
          <option value="scheduled_start:asc">Schedule, soonest</option>
          <option value="priority:asc">Priority</option>
          <option value="reference:desc">Reference</option>
          <option value="title:asc">Title</option>
        </select>
        <button className="secondary" type="submit">Search</button>
      </form>
      {list.isLoading ? <p className="boot">Loading work orders…</p> : null}
      {list.isError ? <Banner>Work orders could not be loaded.</Banner> : null}
      {list.data && list.data.data.length === 0 ? <p className="empty">No work orders match these filters.</p> : null}
      {list.data && list.data.data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Job</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Technician</th>
                <th>Schedule</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((order) => (
                <tr key={order.id}>
                  <td data-label="Reference"><Link to={`/work-orders/${order.id}`}>{order.referenceNumber}</Link></td>
                  <td data-label="Job"><Link to={`/work-orders/${order.id}`}>{order.title}</Link><small>{order.siteName}</small></td>
                  <td data-label="Status"><StatusBadge status={order.status as WorkStatus} /></td>
                  <td data-label="Priority"><PriorityBadge priority={order.priority as Priority} /></td>
                  <td data-label="Technician">{order.technicianName ?? 'Unassigned'}</td>
                  <td data-label="Schedule">{formatRange(order.scheduledStart, order.scheduledEnd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data && total > pageSize ? (
        <div className="pager">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>Next</button>
        </div>
      ) : null}
    </div>
  )
}
