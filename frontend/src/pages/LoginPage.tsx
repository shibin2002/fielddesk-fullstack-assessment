import { FormEvent, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ApiError } from '../api'
import { useAuth } from '../auth'
import { Banner, Field } from '../components'

export function LoginPage() {
  const { user, ready, login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  if (!ready) return <p className="boot">Opening FieldDesk…</p>
  if (user) return <Navigate to="/" replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      await login(email, password)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <section className="login-story">
        <p className="eyebrow">Field service dispatch</p>
        <h1>Work that stays inside the company it belongs to.</h1>
        <p>Schedule technicians, record progress, and keep every organisation’s jobs, files, and history separate.</p>
        <ul>
          <li>Owners manage the team</li>
          <li>Dispatchers assign the day</li>
          <li>Technicians update the job in front of them</li>
        </ul>
      </section>
      <form className="login-card" onSubmit={onSubmit}>
        <h2>Sign in</h2>
        {error ? <Banner>{error}</Banner> : null}
        <Field label="Email">
          <input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label="Password">
          <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <button className="primary" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
