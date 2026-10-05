-- FieldDesk initial schema.
-- Organisation isolation is a column on every tenant table plus query predicates.
-- Overlapping technician assignments are rejected by an exclusion constraint so the
-- rule holds for every API process, not only the one that performed an in-memory check.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable_row' USING ERRCODE = '55000';
END;
$$;

CREATE TABLE organisations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes > 0),
  storage_used_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  notification_mode text NOT NULL DEFAULT 'success'
    CHECK (notification_mode IN ('success', 'transient', 'permanent', 'transient_twice')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organisations_updated_at
BEFORE UPDATE ON organisations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'dispatcher', 'technician')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_organisation_idx ON users (organisation_id);

CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_sessions_user_idx ON refresh_sessions (user_id);

CREATE TABLE reference_counters (
  organisation_id uuid PRIMARY KEY REFERENCES organisations (id),
  prefix text NOT NULL,
  last_value integer NOT NULL CHECK (last_value >= 0)
);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  reference_number text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status text NOT NULL CHECK (status IN ('open', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  assigned_technician_id uuid REFERENCES users (id),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  site_name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, reference_number),
  CHECK (
    (scheduled_start IS NULL AND scheduled_end IS NULL)
    OR (scheduled_end > scheduled_start)
  ),
  CHECK (
    assigned_technician_id IS NULL
    OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)
  )
);

CREATE INDEX work_orders_org_created_idx
  ON work_orders (organisation_id, created_at DESC, id DESC);
CREATE INDEX work_orders_org_status_idx
  ON work_orders (organisation_id, status);
CREATE INDEX work_orders_technician_idx
  ON work_orders (assigned_technician_id);

-- Half-open ranges: a job ending at 11:00 does not overlap one starting at 11:00.
-- Completed and cancelled rows drop out of the constraint, freeing the technician.
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_no_overlap
  EXCLUDE USING gist (
    assigned_technician_id WITH =,
    tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
  )
  WHERE (
    assigned_technician_id IS NOT NULL
    AND status NOT IN ('completed', 'cancelled')
  );

CREATE TRIGGER work_orders_updated_at
BEFORE UPDATE ON work_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE progress_events (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  event_id text NOT NULL,
  work_order_id uuid NOT NULL REFERENCES work_orders (id),
  actor_id uuid NOT NULL REFERENCES users (id),
  type text NOT NULL CHECK (type IN ('status_changed', 'note_added')),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, event_id)
);

CREATE INDEX progress_events_work_order_idx ON progress_events (work_order_id);

CREATE TRIGGER progress_events_immutable
BEFORE UPDATE OR DELETE ON progress_events
FOR EACH ROW EXECUTE FUNCTION reject_row_mutation();

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  work_order_id uuid NOT NULL REFERENCES work_orders (id),
  uploaded_by uuid NOT NULL REFERENCES users (id),
  storage_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_work_order_idx ON attachments (work_order_id);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  actor_id uuid REFERENCES users (id),
  actor_label text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_created_idx ON audit_log (organisation_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);

CREATE TRIGGER audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_row_mutation();

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  work_order_id uuid NOT NULL REFERENCES work_orders (id),
  technician_id uuid NOT NULL REFERENCES users (id),
  idempotency_key text NOT NULL UNIQUE,
  simulation_mode text NOT NULL
    CHECK (simulation_mode IN ('success', 'transient', 'permanent', 'transient_twice')),
  status text NOT NULL
    CHECK (status IN ('pending', 'sending', 'retrying', 'succeeded', 'failed_permanent', 'failed_exhausted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_deliveries_org_idx
  ON notification_deliveries (organisation_id, created_at DESC);
CREATE INDEX notification_deliveries_status_idx
  ON notification_deliveries (status, updated_at);

CREATE TRIGGER notification_deliveries_updated_at
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES notification_deliveries (id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('success', 'transient_failure', 'permanent_failure')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);

-- One provider acceptance per delivery. A retried job that already succeeded
-- observes this row and does not send a second notification.
CREATE TABLE provider_receipts (
  delivery_id uuid PRIMARY KEY REFERENCES notification_deliveries (id),
  provider_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
