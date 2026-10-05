import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { App } from '../App'
import { AuthProvider } from '../auth'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class {
    onopen: (() => void) | null = null
    onmessage: (() => void) | null = null
    onerror: (() => void) | null = null
    close() {}
  })
})

it('shows the server error when sign-in fails', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input)
    if (url.includes('/api/auth/me') || url.includes('/api/auth/refresh') || url.includes('/api/auth/login')) {
      return json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401)
    }
    return json({ error: { message: 'missing' } }, 404)
  }))
  renderAt('/login')
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  await user.type(screen.getByLabelText('Email'), 'dispatcher@northwind.test')
  await user.type(screen.getByLabelText('Password'), 'wrong-password')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
})
