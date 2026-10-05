import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useAuth } from '../auth'
import { Banner, Field } from '../components'
import { fromLocalInput, toLocalInput } from '../format'
import type { Priority, WorkOrder } from '../types'

type Technicians = { data: { id: string; name: string }[] }

export function WorkOrderFormPage() {
  const { id } = useParams()
  const editing = Boolean(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const existing = useQuery({
    queryKey: ['work-order', id],
    queryFn: () => api<WorkOrder>(`/api/work-orders/${id}`),
    enabled: editing,
  })
  const technicians = useQuery({
    queryKey: ['technicians'],
    queryFn: () => api<Technicians>('/api/technicians'),
  })
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [siteName, setSiteName] = useState('')
  const [technicianId, setTechnicianId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    if (!existing.data) return
    setTitle(existing.data.title)
    setDescription(existing.data.description)
    setPriority(existing.data.priority)
    setSiteName(existing.data.siteName)
    setTechnicianId(existing.data.technicianId ?? '')
    setStart(toLocalInput(existing.data.scheduledStart))
    setEnd(toLocalInput(existing.data.scheduledEnd))
  }, [existing.data])

  const save = useMutation({
    mutationFn: async () => {
      const local: Record<string, string> = {}
      if (title.trim().length < 3) local.title = 'Title must be at least 3 characters'
      if (siteName.trim().length < 2) local.siteName = 'Site name is required'
      if (technicianId && (!start || !end)) local.scheduledStart = 'A technician assignment needs a start and end'
      if (Object.keys(local).length > 0) {
        setFields(local)
        throw new ApiError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { fields: local })
      }
      if (editing && existing.data) {
        await api(`/api/work-orders/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            priority,
            siteName: siteName.trim(),
            version: existing.data.version,
          }),
        })
        if (
          technicianId !== (existing.data.technicianId ?? '') ||
          start !== toLocalInput(existing.data.scheduledStart) ||
          end !== toLocalInput(existing.data.scheduledEnd)
        ) {
          const fresh = await api<WorkOrder>(`/api/work-orders/${id}`)
          await api(`/api/work-orders/${id}/assignment`, {
            method: 'POST',
            body: JSON.stringify({
              technicianId: technicianId || null,
              scheduledStart: fromLocalInput(start),
              scheduledEnd: fromLocalInput(end),
              version: fresh.version,
            }),
          })
        }
        return id
      }
      const created = await api<WorkOrder>('/api/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          priority,
          siteName: siteName.trim(),
          technicianId: technicianId || null,
          scheduledStart: fromLocalInput(start),
          scheduledEnd: fromLocalInput(end),
        }),
      })
      return created.id
    },
    onSuccess: async (workOrderId) => {
      await queryClient.invalidateQueries()
      navigate(`/work-orders/${workOrderId}`)
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === 'VALIDATION_ERROR') {
        setFields(caught.details.fields ?? {})
        setError(caught.message)
        return
      }
      setError(caught instanceof Error ? caught.message : 'Could not save the work order')
    },
  })

  if (user?.role === 'technician') {
    return <div className="page"><Banner>Technicians cannot create or edit work orders.</Banner></div>
  }
  if (editing && existing.isLoading) return <p className="boot">Loading work order…</p>

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setFields({})
    save.mutate()
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">{editing ? existing.data?.referenceNumber : 'Dispatch'}</p>
          <h1>{editing ? 'Edit work order' : 'New work order'}</h1>
        </div>
        <Link to={editing ? `/work-orders/${id}` : '/work-orders'}>Cancel</Link>
      </header>
      {error ? <Banner>{error}</Banner> : null}
      <form className="card form-grid" onSubmit={onSubmit}>
        <Field label="Title" error={fields.title}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Site" error={fields.siteName}>
          <input value={siteName} onChange={(event) => setSiteName(event.target.value)} />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field label="Description">
          <textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="Technician" error={fields.technicianId}>
          <select value={technicianId} onChange={(event) => setTechnicianId(event.target.value)}>
            <option value="">Unassigned</option>
            {technicians.data?.data.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </select>
        </Field>
        <div className="pair">
          <Field label="Scheduled start" error={fields.scheduledStart}>
            <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
          </Field>
          <Field label="Scheduled end" error={fields.scheduledEnd}>
            <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
          </Field>
        </div>
        <button className="primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create work order'}</button>
      </form>
    </div>
  )
}
