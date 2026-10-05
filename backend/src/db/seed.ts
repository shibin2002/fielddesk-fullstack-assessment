import { getConfig } from '../config'
import { getPool, query } from './pool'
import { hashPassword } from '../password'

const PASSWORD = 'FieldDesk-Assess-1'

const NW = '10000000-0000-4000-8000-000000000001'
const HL = '20000000-0000-4000-8000-000000000002'
const NW_OWNER = '10000000-0000-4000-8000-000000000011'
const NW_DISPATCHER = '10000000-0000-4000-8000-000000000012'
const NW_ALEX = '10000000-0000-4000-8000-000000000013'
const NW_SAM = '10000000-0000-4000-8000-000000000014'
const HL_OWNER = '20000000-0000-4000-8000-000000000021'
const HL_DISPATCHER = '20000000-0000-4000-8000-000000000022'
const HL_RORY = '20000000-0000-4000-8000-000000000023'

function atDay(offset: number, hour: number, minute = 0): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0)
}

export async function seed(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD)
  const limit = getConfig().defaultStorageLimitBytes
  await query(
    `INSERT INTO organisations (id, name, storage_limit_bytes)
     VALUES ($1, 'Northwind Maintenance', $3), ($2, 'Harborline Services', $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [NW, HL, limit],
  )
  const users = [
    [NW_OWNER, NW, 'owner@northwind.test', 'Olivia Marsh', 'owner'],
    [NW_DISPATCHER, NW, 'dispatcher@northwind.test', 'Dana Okonkwo', 'dispatcher'],
    [NW_ALEX, NW, 'alex.rivera@northwind.test', 'Alex Rivera', 'technician'],
    [NW_SAM, NW, 'sam.patel@northwind.test', 'Sam Patel', 'technician'],
    [HL_OWNER, HL, 'owner@harborline.test', 'Owen Brooks', 'owner'],
    [HL_DISPATCHER, HL, 'dispatcher@harborline.test', 'Devon Clarke', 'dispatcher'],
    [HL_RORY, HL, 'rory.nguyen@harborline.test', 'Rory Nguyen', 'technician'],
  ]
  for (const [id, organisationId, email, name, role] of users) {
    await query(
      `INSERT INTO users (id, organisation_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, email = EXCLUDED.email`,
      [id, organisationId, email, name, passwordHash, role],
    )
  }
  await query(
    `INSERT INTO reference_counters (organisation_id, prefix, last_value)
     VALUES ($1, 'NW', 10424), ($2, 'HL', 22012)
     ON CONFLICT (organisation_id) DO NOTHING`,
    [NW, HL],
  )

  const alexStart = atDay(1, 9)
  const alexEnd = atDay(1, 11)
  const liveStart = new Date(Date.now() - 60 * 60 * 1000)
  const liveEnd = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const samStart = atDay(1, 13)
  const samEnd = atDay(1, 15)
  const doneStart = atDay(-1, 9)
  const doneEnd = atDay(-1, 11)
  const roryStart = atDay(1, 10)
  const roryEnd = atDay(1, 12)

  const orders = [
    ['10000000-0000-4000-8000-000000000101', NW, 'NW-10421', 'Replace rooftop condenser fan', 'Fan motor is noisy and tripping the breaker on the west retail unit.', 'high', 'scheduled', NW_ALEX, alexStart, alexEnd, 'West Retail Unit, 400 Harbor Ave', NW_DISPATCHER],
    ['10000000-0000-4000-8000-000000000102', NW, 'NW-10422', 'Boiler safety inspection', 'Annual low-water cutoff and flame safeguard check.', 'medium', 'in_progress', NW_ALEX, liveStart, liveEnd, 'Northwind Plant, Boiler Room', NW_DISPATCHER],
    ['10000000-0000-4000-8000-000000000103', NW, 'NW-10423', 'Quarterly filter service', 'Replace filters on air handlers 2 and 3. No technician assigned yet.', 'low', 'open', null, null, null, 'Civic Library, Mechanical Mezzanine', NW_DISPATCHER],
    ['10000000-0000-4000-8000-000000000104', NW, 'NW-10418', 'Loading dock leak', 'Emergency call. Joint resealed and area dried.', 'urgent', 'completed', NW_SAM, doneStart, doneEnd, 'Loading Dock B', NW_DISPATCHER],
    ['10000000-0000-4000-8000-000000000105', NW, 'NW-10424', 'After-hours panel survey', 'Sam is booked tomorrow afternoon. Use this window to test a non-overlapping assignment.', 'medium', 'scheduled', NW_SAM, samStart, samEnd, 'Depot 4 Switchgear', NW_DISPATCHER],
    ['20000000-0000-4000-8000-000000000201', HL, 'HL-22011', 'Service port generator', 'Load-test the standby generator before the weekend ferry schedule.', 'high', 'scheduled', HL_RORY, roryStart, roryEnd, 'Pier 2 Generator Shed', HL_DISPATCHER],
    ['20000000-0000-4000-8000-000000000202', HL, 'HL-22012', 'Calibrate bilge sensors', 'Two sensors on the workshop barge are reading low.', 'medium', 'open', null, null, null, 'Workshop Barge', HL_DISPATCHER],
  ] as const

  for (const order of orders) {
    await query(
      `INSERT INTO work_orders (
         id, organisation_id, reference_number, title, description, priority, status,
         assigned_technician_id, scheduled_start, scheduled_end, site_name, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         scheduled_start = EXCLUDED.scheduled_start,
         scheduled_end = EXCLUDED.scheduled_end`,
      [...order],
    )
    await query(
      `INSERT INTO audit_log (id, organisation_id, actor_id, actor_label, action, target_type, target_id, after_state)
       VALUES ($1, $2, $3, 'seed', 'work_order.created', 'work_order', $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        order[0].replace('0000000001', '0000000009').replace('0000000002', '0000000009'),
        order[1],
        order[11],
        order[0],
        JSON.stringify({ title: order[3], status: order[6], referenceNumber: order[2] }),
      ],
    )
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'seed complete',
    password: PASSWORD,
    accounts: users.map((user) => ({ email: user[2], role: user[4], organisation: user[1] === NW ? 'Northwind Maintenance' : 'Harborline Services' })),
  }))
}

if (require.main === module) {
  seed()
    .then(async () => {
      await getPool().end()
    })
    .catch(async (error) => {
      console.error(error)
      await getPool().end().catch(() => undefined)
      process.exit(1)
    })
}
