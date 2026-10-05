export type Role = 'owner' | 'dispatcher' | 'technician'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type WorkStatus = 'open' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
export type NotificationMode = 'success' | 'transient' | 'permanent' | 'transient_twice'

export type SessionUser = {
  id: string
  email: string
  name: string
  role: Role
  organisationId: string
  organisationName: string
}

export type WorkOrder = {
  id: string
  referenceNumber: string
  title: string
  description: string
  priority: Priority
  status: WorkStatus
  technicianId: string | null
  technicianName: string | null
  scheduledStart: string | null
  scheduledEnd: string | null
  siteName: string
  createdBy: string
  createdByName: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type Activity = {
  id: string
  actorId: string | null
  actorLabel: string
  action: string
  before: unknown
  after: unknown
  createdAt: string
}

export type Attachment = {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  createdAt: string
}

export type ScheduleConflict = {
  id: string
  referenceNumber: string
  title: string
  scheduledStart: string
  scheduledEnd: string
}
