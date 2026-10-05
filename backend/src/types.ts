export type Role = 'owner' | 'dispatcher' | 'technician'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type WorkStatus = 'open' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
export type NotificationMode = 'success' | 'transient' | 'permanent' | 'transient_twice'

export type AuthContext = {
  userId: string
  organisationId: string
  role: Role
  email: string
  name: string
  organisationName: string
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}

export type WorkOrderJson = {
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

export type WorkOrderRow = {
  id: string
  organisation_id: string
  reference_number: string
  title: string
  description: string
  priority: Priority
  status: WorkStatus
  assigned_technician_id: string | null
  technician_name: string | null
  scheduled_start: Date | null
  scheduled_end: Date | null
  site_name: string
  created_by: string
  created_by_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}
