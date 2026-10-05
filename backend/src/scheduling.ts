import { AppError } from './errors'

const MIN_WINDOW_MS = 15 * 60 * 1000
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const MAX_PAST_MS = 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000

export function assertScheduleWindow(start: Date, end: Date, now = new Date()): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledStart: 'Enter a valid schedule' },
    })
  }
  if (end <= start) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledEnd: 'End must be after the start' },
    })
  }
  const duration = end.getTime() - start.getTime()
  if (duration < MIN_WINDOW_MS) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledEnd: 'Schedule must be at least 15 minutes' },
    })
  }
  if (duration > MAX_WINDOW_MS) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledEnd: 'Schedule cannot be longer than 14 days' },
    })
  }
  if (end.getTime() < now.getTime() - MAX_PAST_MS) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledEnd: 'Schedule end is too far in the past' },
    })
  }
  if (start.getTime() > now.getTime() + MAX_FUTURE_MS) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledStart: 'Schedule start is too far in the future' },
    })
  }
}

export function parseSchedule(
  start: string | null | undefined,
  end: string | null | undefined,
): { start: Date | null; end: Date | null } {
  if (!start && !end) return { start: null, end: null }
  if (!start || !end) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', {
      fields: { scheduledStart: 'Provide both a start and an end' },
    })
  }
  const parsedStart = new Date(start)
  const parsedEnd = new Date(end)
  assertScheduleWindow(parsedStart, parsedEnd)
  return { start: parsedStart, end: parsedEnd }
}
