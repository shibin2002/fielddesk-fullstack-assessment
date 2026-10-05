import type { ScheduleConflict } from './types'

export class ApiError extends Error {
  status: number
  code: string
  details: { fields?: Record<string, string>; conflicts?: ScheduleConflict[] }

  constructor(status: number, code: string, message: string, details?: ApiError['details']) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details ?? {}
  }
}

let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-FieldDesk-Request': '1' },
  })
  return response.ok
}

export async function api<T>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-FieldDesk-Request', '1')
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (response.status === 401 && allowRefresh && !path.startsWith('/api/auth/')) {
    refreshInFlight ??= refreshSession().finally(() => {
      refreshInFlight = null
    })
    if (await refreshInFlight) return api<T>(path, init, false)
  }
  const text = await response.text()
  const body = text ? JSON.parse(text) as { error?: { code?: string; message?: string; details?: ApiError['details'] } } : {}
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? 'Request failed',
      body.error?.details,
    )
  }
  return body as T
}

export async function downloadCsv(query: string): Promise<void> {
  let response = await fetch(`/api/work-orders/export?${query}`, { credentials: 'include' })
  if (response.status === 401) {
    refreshInFlight ??= refreshSession().finally(() => {
      refreshInFlight = null
    })
    if (await refreshInFlight) {
      response = await fetch(`/api/work-orders/export?${query}`, { credentials: 'include' })
    }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } }
    throw new ApiError(response.status, body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? 'Export failed')
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'fielddesk-work-orders.csv'
  link.click()
  URL.revokeObjectURL(url)
}
