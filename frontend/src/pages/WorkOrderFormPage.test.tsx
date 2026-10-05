import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { App } from '../App'
import { AuthProvider } from '../auth'

const dispatcher = {
  id: '10000000-0000-4000-8000-000000000012',
  email: 'dispatcher@northwind.test',
  name: 'Dana Okonkwo',
  role: 'dispatcher',
  organisationId: '10000000-0000-4000-8000-000000000001',
  organisationName: 'Northwind Maintenance',
}

const created = {
  id: '10000000-0000-4000-8000-000000000199',
  referenceNumber: 'NW-10430',
  title: 'Replace condenser fan',
  description: 'Noisy motor',
  priority: 'high',
  status: 'open',
  technicianId: null,
  technicianName: null,
  scheduledStart: null,
  scheduledEnd: null,
  siteName: 'West Retail Unit',
  createdBy: dispatcher.id,
  createdByName: dispatcher.name,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class {
    onopen: (() => void) | null = null
    onmessage: (() => void) | null = null
    onerror: (() => void) | null = null
    close() {}
  })
})

it('validates the work order form and creates a job through the API', async () => {
  const user = userEvent.setup()
  let payload: Record<string, unknown> | null = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/api/auth/me')) return json({ user: dispatcher })
    if (url.includes('/api/technicians')) return json({ data: [{ id: '10000000-0000-4000-8000-000000000013', name: 'Alex Rivera' }] })
    if (url.endsWith('/api/work-orders') && method === 'POST') {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json(created, 201)
    }
    if (url.includes('/activity')) return json({ data: [] })
    if (url.includes('/attachments')) return json({ data: [] })
    if (url.includes('/api/work-orders/')) return json(created)
    return json({})
  }))

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/work-orders/new']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )

  expect(await screen.findByRole('heading', { name: 'New work order' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Create work order' }))
  expect(await screen.findByText('Title must be at least 3 characters')).toBeInTheDocument()
  expect(payload).toBeNull()

  await user.type(screen.getByLabelText(/^Title/), 'Replace condenser fan')
  await user.type(screen.getByLabelText(/^Site/), 'West Retail Unit')
  await user.type(screen.getByLabelText(/^Description/), 'Noisy motor')
  await user.click(screen.getByRole('button', { name: 'Create work order' }))

  expect(await screen.findByRole('heading', { name: 'Replace condenser fan' })).toBeInTheDocument()
  expect(payload).toMatchObject({
    title: 'Replace condenser fan',
    siteName: 'West Retail Unit',
    priority: 'medium',
    technicianId: null,
  })
})
