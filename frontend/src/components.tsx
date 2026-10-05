import type { ReactNode } from 'react'
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import { useLiveUpdates } from './live'
import type { Priority, Role, WorkStatus } from './types'
import { titleCaseStatus } from './format'

export function StatusBadge({ status }: { status: WorkStatus }) {
  return <span className={`badge status-${status}`}>{titleCaseStatus(status)}</span>
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge priority-${priority}`}>{priority}</span>
}

export function RoleBadge({ role }: { role: Role }) {
  return <span className="badge role">{role}</span>
}

export function Banner({ tone = 'error', children }: { tone?: 'error' | 'info'; children: ReactNode }) {
  return <div className={`banner banner-${tone}`} role="alert">{children}</div>
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  )
}

export function Shell() {
  const { user, ready, logout } = useAuth()
  const navigate = useNavigate()
  const live = useLiveUpdates(Boolean(user))
  if (!ready) return <p className="boot">Opening FieldDesk…</p>
  if (!user) return <Navigate to="/login" replace />
  const dispatch = user.role !== 'technician'

  return (
    <div className="shell">
      <a className="skip" href="#content">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>FieldDesk</strong>
            <em>{user.organisationName}</em>
          </div>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/work-orders">Work orders</NavLink>
          {user.role === 'owner' ? <NavLink to="/team">Team</NavLink> : null}
          {user.role === 'owner' ? <NavLink to="/settings">Settings</NavLink> : null}
        </nav>
        <div className="sidebar-foot">
          <p className={live ? 'live on' : 'live'}>{live ? 'Live updates on' : 'Live updates paused'}</p>
          <p className="who"><b>{user.name}</b><RoleBadge role={user.role} /></p>
          <button type="button" className="ghost" onClick={() => void logout().then(() => navigate('/login'))}>Sign out</button>
        </div>
      </aside>
      <main id="content">
        {dispatch ? null : <p className="tech-note">You are signed in as a technician. You can see assigned work and post progress.</p>}
        <Outlet />
      </main>
    </div>
  )
}
