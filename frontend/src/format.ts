export function formatWhen(value: string | null | undefined): string {
  if (!value) return 'Not scheduled'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'Not scheduled'
  return `${formatWhen(start)} – ${formatWhen(end)}`
}

export function toLocalInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function titleCaseStatus(status: string): string {
  return status.replaceAll('_', ' ')
}

export function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    'work_order.created': 'Created the work order',
    'work_order.updated': 'Updated details',
    'work_order.assigned': 'Changed the assignment',
    'work_order.status_changed': 'Changed the status',
    'work_order.note_added': 'Added a note',
    'attachment.added': 'Added an attachment',
    'notification.succeeded': 'Notification delivered',
    'notification.failed': 'Notification failed',
    'notification.retrying': 'Notification will retry',
    'user.created': 'Added a user',
    'user.role_changed': 'Changed a role',
    'user.disabled': 'Disabled a user',
    'user.enabled': 'Enabled a user',
  }
  return labels[action] ?? action
}

export function greeting(name: string): string {
  const hour = new Date().getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  return `${hello}, ${name.split(' ')[0]}`
}
