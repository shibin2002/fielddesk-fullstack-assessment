import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FormEvent, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useAuth } from '../auth'
import { Banner, Field, RoleBadge } from '../components'
import type { Role } from '../types'

type UserRow = { id: string; name: string; email: string; role: Role; disabled: boolean }

export function TeamPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('technician')
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ data: UserRow[] }>('/api/users') })
  const create = useMutation({
    mutationFn: () => api('/api/users', { method: 'POST', body: JSON.stringify({ name, email, password, role }) }),
    onSuccess: async () => {
      setName('')
      setEmail('')
      setPassword('')
      setError('')
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'Could not add the user'),
  })
  const patch = useMutation({
    mutationFn: (input: { id: string; role?: Role; disabled?: boolean }) => api(`/api/users/${input.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: input.role, disabled: input.disabled }),
    }),
    onSuccess: async () => {
      setError('')
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : 'Could not update the user'),
  })

  if (user && user.role !== 'owner') return <Navigate to="/" replace />

  function onCreate(event: FormEvent) {
    event.preventDefault()
    create.mutate()
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Organisation</p>
          <h1>Team</h1>
        </div>
      </header>
      {error ? <Banner>{error}</Banner> : null}
      <form className="card form-grid" onSubmit={onCreate}>
        <h2>Add a person</h2>
        <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
        <Field label="Temporary password"><input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} /></Field>
        <Field label="Role">
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="owner">Owner</option>
            <option value="dispatcher">Dispatcher</option>
            <option value="technician">Technician</option>
          </select>
        </Field>
        <button className="primary" type="submit" disabled={create.isPending}>Add user</button>
      </form>
      {users.isLoading ? <p className="boot">Loading team…</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th></tr></thead>
          <tbody>
            {users.data?.data.map((member) => (
              <tr key={member.id}>
                <td data-label="Name">{member.name} {member.id === user?.id ? <small>You</small> : null}</td>
                <td data-label="Email">{member.email}</td>
                <td data-label="Role">
                  <RoleBadge role={member.role} />
                  <select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => patch.mutate({ id: member.id, role: event.target.value as Role })}>
                    <option value="owner">Owner</option>
                    <option value="dispatcher">Dispatcher</option>
                    <option value="technician">Technician</option>
                  </select>
                </td>
                <td data-label="Access">
                  <button type="button" className="secondary" disabled={member.id === user?.id} onClick={() => patch.mutate({ id: member.id, disabled: !member.disabled })}>
                    {member.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
