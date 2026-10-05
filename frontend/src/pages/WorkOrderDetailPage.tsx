import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FormEvent, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useAuth } from '../auth'
import { Banner, Field, PriorityBadge, StatusBadge } from '../components'
import { actionLabel, formatBytes, formatRange, formatWhen, fromLocalInput, toLocalInput } from '../format'
import type { Activity, Attachment, ScheduleConflict, WorkOrder, WorkStatus } from '../types'

type Technicians = { data: { id: string; name: string }[] }

export function WorkOrderDetailPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([])
  const [note, setNote] = useState('')
  const [nextStatus, setNextStatus] = useState<'in_progress' | 'completed'>('in_progress')
  const workOrder = useQuery({
    queryKey: ['work-order', id],
    queryFn: () => api<WorkOrder>(`/api/work-orders/${id}`),
  })
  const activity = useQuery({
    queryKey: ['activity', id],
    queryFn: () => api<{ data: Activity[] }>(`/api/work-orders/${id}/activity`),
  })
  const attachments = useQuery({
    queryKey: ['attachments', id],
    queryFn: () => api<{ data: Attachment[] }>(`/api/work-orders/${id}/attachments`),
  })
  const technicians = useQuery({
    queryKey: ['technicians'],
    queryFn: () => api<Technicians>('/api/technicians'),
    enabled: user?.role !== 'technician',
  })

  const order = workOrder.data
  const [technicianId, setTechnicianId] = useState<string | null>(null)
  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)
  const techValue = technicianId ?? order?.technicianId ?? ''
  const startValue = start ?? (order ? toLocalInput(order.scheduledStart) : '')
  const endValue = end ?? (order ? toLocalInput(order.scheduledEnd) : '')

  function explain(caught: unknown) {
    if (caught instanceof ApiError) {
      setConflicts(caught.details.conflicts ?? [])
      setError(caught.message)
      return
    }
    setError(caught instanceof Error ? caught.message : 'Request failed')
  }

  const assign = useMutation({
    mutationFn: () => api<WorkOrder>(`/api/work-orders/${id}/assignment`, {
      method: 'POST',
      body: JSON.stringify({
        technicianId: techValue || null,
        scheduledStart: fromLocalInput(startValue),
        scheduledEnd: fromLocalInput(endValue),
        version: order?.version,
      }),
    }),
    onSuccess: async () => {
      setError('')
      setConflicts([])
      setTechnicianId(null)
      setStart(null)
      setEnd(null)
      await queryClient.invalidateQueries()
    },
    onError: explain,
  })

  const status = useMutation({
    mutationFn: (next: WorkStatus) => api(`/api/work-orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next, version: order?.version }),
    }),
    onSuccess: async () => {
      setError('')
      await queryClient.invalidateQueries()
    },
    onError: explain,
  })

  const progress = useMutation({
    mutationFn: (type: 'status_changed' | 'note_added') => api(`/api/work-orders/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        eventId: `evt-${crypto.randomUUID()}`,
        workOrderId: id,
        type,
        occurredAt: new Date().toISOString(),
        payload: type === 'note_added' ? { note } : { status: nextStatus, note: note || undefined },
      }),
    }),
    onSuccess: async () => {
      setNote('')
      setError('')
      await queryClient.invalidateQueries()
    },
    onError: explain,
  })

  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData()
      body.append('file', file)
      return api(`/api/work-orders/${id}/attachments`, { method: 'POST', body })
    },
    onSuccess: async () => {
      setError('')
      await queryClient.invalidateQueries()
    },
    onError: explain,
  })

  if (workOrder.isLoading) return <p className="boot">Loading work order…</p>
  if (workOrder.isError || !order) return <div className="page"><Banner>This work order is not available.</Banner></div>
  const dispatch = user?.role === 'owner' || user?.role === 'dispatcher'

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{order.referenceNumber}</p>
          <h1>{order.title}</h1>
          <p className="meta-line"><StatusBadge status={order.status} /> <PriorityBadge priority={order.priority} /> <span>{order.siteName}</span></p>
        </div>
        {dispatch ? <Link className="secondary button-link" to={`/work-orders/${order.id}/edit`}>Edit</Link> : null}
      </header>
      {error ? <Banner>{error}</Banner> : null}
      {conflicts.length > 0 ? (
        <ul className="conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict.id}>{conflict.referenceNumber} · {conflict.title} · {formatRange(conflict.scheduledStart, conflict.scheduledEnd)}</li>
          ))}
        </ul>
      ) : null}
      <div className="detail">
        <section className="stack">
          <article className="card">
            <h2>Description</h2>
            <p>{order.description || 'No description.'}</p>
            <p className="hint">Created by {order.createdByName ?? 'unknown'} · updated {formatWhen(order.updatedAt)}</p>
          </article>
          <article className="card">
            <h2>Activity</h2>
            {activity.isLoading ? <p>Loading activity…</p> : null}
            {activity.data && activity.data.data.length === 0 ? <p className="empty">No activity yet.</p> : null}
            <ol className="timeline">
              {activity.data?.data.map((entry) => (
                <li key={entry.id}>
                  <b>{actionLabel(entry.action)}</b>
                  <span>{entry.actorLabel} · {formatWhen(entry.createdAt)}</span>
                  {noteText(entry.after) ? <p>{noteText(entry.after)}</p> : null}
                </li>
              ))}
            </ol>
          </article>
        </section>
        <aside className="stack">
          {dispatch ? (
            <form className="card" onSubmit={(event: FormEvent) => { event.preventDefault(); assign.mutate() }}>
              <h2>Assignment</h2>
              <Field label="Technician">
                <select value={techValue} onChange={(event) => setTechnicianId(event.target.value)}>
                  <option value="">Unassigned</option>
                  {technicians.data?.data.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
                </select>
              </Field>
              <Field label="Start"><input type="datetime-local" value={startValue} onChange={(event) => setStart(event.target.value)} /></Field>
              <Field label="End"><input type="datetime-local" value={endValue} onChange={(event) => setEnd(event.target.value)} /></Field>
              <button className="primary" type="submit" disabled={assign.isPending}>{assign.isPending ? 'Saving…' : 'Save assignment'}</button>
              <Field label="Status">
                <select value={order.status} onChange={(event) => status.mutate(event.target.value as WorkStatus)}>
                  {['open', 'scheduled', 'in_progress', 'completed', 'cancelled'].map((item) => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}
                </select>
              </Field>
            </form>
          ) : (
            <form className="card" onSubmit={(event: FormEvent) => { event.preventDefault(); progress.mutate('status_changed') }}>
              <h2>Progress</h2>
              <p className="hint">{formatRange(order.scheduledStart, order.scheduledEnd)}</p>
              <Field label="Status">
                <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value as 'in_progress' | 'completed')}>
                  <option value="in_progress">In progress</option>
                  <option value="completed">Completed</option>
                </select>
              </Field>
              <Field label="Note">
                <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
              <button className="primary" type="submit" disabled={progress.isPending}>Submit progress</button>
              <button className="secondary" type="button" disabled={progress.isPending || note.trim().length === 0} onClick={() => progress.mutate('note_added')}>Add note only</button>
            </form>
          )}
          <article className="card">
            <h2>Attachments</h2>
            <form>
              <input aria-label="Upload attachment" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) upload.mutate(file)
                event.target.value = ''
              }} />
            </form>
            {upload.isPending ? <p>Uploading…</p> : null}
            {attachments.data && attachments.data.data.length === 0 ? <p className="empty">No files yet.</p> : null}
            <ul className="files">
              {attachments.data?.data.map((file) => (
                <li key={file.id}>
                  <a href={`/api/attachments/${file.id}/content`}>{file.fileName}</a>
                  <small>{formatBytes(file.sizeBytes)}</small>
                </li>
              ))}
            </ul>
          </article>
        </aside>
      </div>
    </div>
  )
}

function noteText(after: unknown): string {
  if (!after || typeof after !== 'object' || !('note' in after)) return ''
  const note = (after as { note?: unknown }).note
  return typeof note === 'string' ? note : ''
}
