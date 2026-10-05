# Technical notes

Complete this document as part of the submission.

## Candidate

- Name: shibin
- GitHub username: shibin2002
- Final commit SHA: Not committed yet. `9c4bc017ff8bd38b1b97b230e173b7bdc79c2eff` is only Gatlier's template commit and does not include this implementation. Replace this line with the SHA of the last commit on `assessment/shibin2002` after that branch is pushed.
- Screen-recording link: https://drive.google.com/file/d/1Zx9c-ztLhD4I2-3xn_iOcCSmILFnqVo0/view?usp=drive_link

## Local setup

Docker Compose is the supported path:

```bash
docker compose up --build
```

The web UI is http://localhost:8080. API health is http://localhost:3000/health.

Host processes against Compose Postgres and Redis:

```bash
docker compose up -d postgres redis
copy .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

The UI is then http://localhost:5173.

Without Docker, on a machine with PostgreSQL 17 installed:

```bash
npm install
npm run dev:standalone
```

That command is a local fallback. It is not a substitute for the Compose file.

Checks:

```bash
npm test
npm run lint
npm run build
```

## Sample accounts

Password for every account: `FieldDesk-Assess-1`

| Organisation | Email | Role |
| --- | --- | --- |
| Northwind Maintenance | owner@northwind.test | Owner |
| Northwind Maintenance | dispatcher@northwind.test | Dispatcher |
| Northwind Maintenance | alex.rivera@northwind.test | Technician |
| Northwind Maintenance | sam.patel@northwind.test | Technician |
| Harborline Services | owner@harborline.test | Owner |
| Harborline Services | dispatcher@harborline.test | Dispatcher |
| Harborline Services | rory.nguyen@harborline.test | Technician |

Alex is scheduled tomorrow 09:00–11:00 local time on NW-10421. Giving Alex that same window on another Northwind job conflicts. Sam is free tomorrow 13:00–15:00. Harborline’s data is a separate tenant.

## Verification results

| Check | Command | Result |
| --- | --- | --- |
| Backend tests | `npm test -w backend` | Passed. 9 files, 19 tests, on 5 October 2026 against PostgreSQL 17 and Redis. |
| Frontend tests | `npm test -w frontend` | Passed. Login failure and the create-work-order workflow. |
| Integration tests | Included in `npm test -w backend` | Passed. Auth, roles, tenant isolation, concurrency, events, files, CSV, realtime, and the worker. |
| Lint | `npm run lint` | Passed with zero warnings for the API, worker, and frontend. |
| Build | `npm run build` | Passed. TypeScript compiled for the API and worker. The frontend production bundle built. |
| Live API | `GET /health`, `GET /ready`, login, dashboard, work orders, scheduling conflict | Passed. Owner login returned Northwind data. Assigning Alex Rivera’s existing window returned `409 SCHEDULING_CONFLICT` for `NW-10421`. The FieldDesk page returned HTTP 200. |
| Docker Compose | `docker compose up --build` | Passed. The candidate ran this on another machine and reported the UI and API healthy. |
| Postman | Login, dashboard, work orders, scheduling conflict | Passed. The candidate checked these requests on another machine and reported success. |

## Architecture

```text
Browser
  |  Vite (dev) or nginx (Compose)
  v
API  ---- PostgreSQL
 |  \--- Redis: rate limits, pub/sub, BullMQ
 |  \--- local upload directory
 v
Worker ---- Redis queue and the same PostgreSQL
       \--- mock notification provider
```

- `frontend/` is a React and Vite client. It is not a security boundary.
- `backend/` is a Fastify API. Routes validate input, load the user from the database, and call services that always filter by the organisation on that user.
- `worker/` is a separate Node process. It consumes BullMQ and records notification attempts.
- `database/migrations/` holds versioned SQL. `schema_migrations` records what has been applied.
- `tests/` holds API and database tests. The frontend workflow tests live next to the pages.

The API enqueues work only after the database transaction commits. If Redis is unavailable at that moment, the delivery row stays `pending` and the worker’s recovery query enqueues it again.

## Database design

Principal tables:

- `organisations` owns the storage quota and the notification simulation mode.
- `users` belong to one organisation. Email is unique case-insensitively. `disabled_at` blocks login and assignment.
- `refresh_sessions` stores only the SHA-256 hash of the refresh token.
- `reference_counters` allocates `NW-10425` style numbers under a row lock.
- `work_orders` stores the job, schedule, technician, and optimistic `version`.
- `progress_events` is the immutable accepted event, unique on `(organisation_id, event_id)`.
- `attachments` stores a generated key, not a client path.
- `audit_log` and `progress_events` reject `UPDATE` and `DELETE` with a trigger.
- `notification_deliveries`, `notification_attempts`, and `provider_receipts` record queue outcomes. A receipt is unique per delivery.

The overlap rule is a GiST exclusion constraint on `(assigned_technician_id, tstzrange(scheduled_start, scheduled_end, '[)'))` for rows that are not completed or cancelled. `btree_gist` supplies the UUID equality operator. A job that ends at 11:00 does not block one that starts at 11:00. Completed and cancelled rows leave the constraint, so the technician becomes available again.

List and export queries use `(organisation_id, created_at DESC, id DESC)`. Status and technician filters have their own indexes. Migrations are plain SQL files applied in order inside a transaction.

## Authentication, roles and organisation isolation

Passwords are hashed with scrypt (cost 16384, block size 8, parallelization 1). The login response sets two HttpOnly, SameSite=Lax cookies: a 15-minute JWT access token and a rotating refresh token. The JWT carries the user id and organisation id. It does not carry the role.

Every authenticated request loads the user again. The database role and organisation win. A disabled user, a mismatched organisation, or a revoked refresh token is rejected. Reuse of a revoked refresh token revokes that user’s remaining sessions.

Mutating browser requests must send `X-FieldDesk-Request: 1`. A cross-site form cannot set that header. Bearer tokens are accepted for non-browser clients and skip the header check.

Authorisation:

- Owner: users, organisation notification mode, and everything a dispatcher can do.
- Dispatcher: create, edit, assign, and change work-order status.
- Technician: list and open only assigned work orders, upload files on those jobs, and submit progress events. Other jobs in the same organisation return 404.

Organisation id is taken from the loaded user. Body fields and query parameters named `organisationId` are ignored. A foreign id returns 404 rather than 403 so the caller cannot learn that the row exists. The last active owner cannot be demoted or disabled. Users cannot disable themselves.

Login is rate limited per IP. Progress events are rate limited per user. Both counters live in Redis so a second API instance shares them. `TRUST_PROXY` is off unless the process is behind the Compose nginx proxy, because a client-supplied forwarded IP would otherwise bypass the login limit.

## Transactions, idempotency and concurrency

Work-order writes run in one database transaction. Deadlocks are retried. External effects (queue and realtime publish, and the attachment file write) are outside that transaction or are compensated.

Assignment locks the work-order row, then locks the technician row with `SELECT … FOR UPDATE`. The overlap query runs only after those locks. Two API processes assigning the same technician therefore queue on the technician row in PostgreSQL. The exclusion constraint is the backstop if a future code path forgets the lock: PostgreSQL aborts one of the two commits with `23P01`, and the API maps that to `409 SCHEDULING_CONFLICT`. An in-memory lock would not do this across processes. The constraint does.

Progress events lock the work order, then insert the event with `ON CONFLICT (organisation_id, event_id) DO NOTHING`. The winner applies the status change and writes the audit row before commit. The loser reads the stored event and returns `200` with `idempotentReplay: true`. A different payload does not get applied. The same `eventId` for a different work order returns `409`. A test failpoint, enabled only when `NODE_ENV=test`, throws after the insert so the test can prove the event and the status change roll back together. That header does nothing outside the test environment.

Creating a work order ignores a client-supplied status and organisation. A technician assignment on create goes through the same overlap checks and writes the notification row in the same transaction.

CSV export uses `REPEATABLE READ READ ONLY` and keyset pages of 200 rows. Filters are the same SQL predicate as the list, including the technician’s assigned-only scope. Cells that start with `=`, `+`, `-`, `@`, tab, or carriage return are prefixed with a single quote.

## Background jobs

Assigning a technician inserts `notification_deliveries` with a unique idempotency key of work order, technician, start, and end. Repeating the same assignment does not create a second delivery. The BullMQ job id is the delivery id, so a duplicate enqueue is ignored.

The worker claims the row by moving it to `sending` and incrementing `attempts`. The mock provider then:

- `success`: accepts immediately
- `transient`: times out on every attempt
- `transient_twice`: times out on attempts 1 and 2, then accepts
- `permanent`: rejects the destination

Temporary failures are recorded and rethrown so BullMQ retries with exponential backoff. The default is 5 attempts, starting at 1 second. Permanent failures are recorded and not rethrown, so BullMQ does not retry them. When the last temporary attempt is still failing, the worker marks the delivery `failed_exhausted`.

`provider_receipts` has one row per delivery. A retry that already obtained a receipt returns that id and does not create another. A second `processDelivery` call after success returns without calling the provider again.

Every 10 seconds the worker re-enqueues deliveries that are still `pending`, `retrying`, or `sending` and have not been updated for 15 seconds. That covers an API crash after commit and before enqueue. A live job with the same id is left alone.

Each attempt and the final outcome are stored, written to the immutable audit log, and logged as JSON. The worker publishes `notification.updated` on the organisation’s Redis channel.

Owners change the simulation mode in Settings. The mode is copied onto the delivery when it is created, so a later settings change does not rewrite an in-flight job.

## Real-time updates

`GET /api/stream` is a cookie-authenticated Server-Sent Events response. The server subscribes to `fielddesk:org:*` and writes only to connections registered for that organisation id. The id comes from the authenticated user, not from the query string.

Publishing is Redis pub/sub, so more than one API instance can serve streams. The latest 50 events per organisation are kept for `Last-Event-ID` replay. If the id has fallen out of that buffer, the server emits `resync` and the client reloads its queries. The browser `EventSource` reconnects on its own (`retry: 4000`). On every open, the client invalidates its cached queries.

If Redis publish fails, the API still commits the business change and logs a warning. The live indicator in the sidebar turns off while the stream is disconnected. Refreshing the page reads current data from the API. Realtime delivery is best-effort; the database is the source of truth.

## File security and storage limits

Uploads are limited to 5 MB by default. The API accepts only buffers whose bytes are PDF, PNG, JPEG, GIF, or WEBP. The client content type is not trusted. SVG is rejected. The stored name is a sanitised display label. The file path is `{uploadDir}/{organisationId}/{attachmentId}`, built only from UUIDs that the server generated, then checked so it cannot escape the upload root. Responses never include that path.

Quota is a conditional update:

```sql
UPDATE organisations
SET storage_used_bytes = storage_used_bytes + $size
WHERE id = $org AND storage_used_bytes + $size <= storage_limit_bytes
```

The organisation row lock makes concurrent uploads observe each other’s usage. Failure returns `409 STORAGE_QUOTA_EXCEEDED` and the file is deleted. Downloads check the attachment’s organisation and, for a technician, that they are assigned to the work order. Missing or foreign files return 404. `X-Content-Type-Options: nosniff` is set.

In production I would replace `writeUpload` with a PUT to object storage using the same generated key, a short-lived signed GET, a bucket policy that is not public, and server-side encryption. The database row would still be the authorisation record. A lifecycle rule or a daily job would delete objects whose database row never committed. The quota update would stay in PostgreSQL. ClamAV or the storage provider’s malware scan would run before the object becomes readable. The API shape would not change.

## Security considerations

- Stolen XSS would still be serious, but tokens are not in `localStorage`.
- Cross-site mutation is blocked by the custom header plus `SameSite=Lax`.
- Login errors do not reveal whether the email exists or the account is disabled. A dummy scrypt hash is verified when the user is missing.
- Sort columns and directions are whitelisted. Search uses bound parameters and an escaped `ILIKE` pattern.
- Audit rows and accepted progress events cannot be updated through SQL without dropping the trigger, and no API route updates them.
- Errors returned to clients use a stable code and message. SQL text stays in the server log with the request id.
- Logs redact authorization and cookie headers and the password field.
- `.env` is gitignored. `.env.example` and the Compose file contain only local placeholders.
- Attachment paths are not taken from the original filename.
- CSV formula injection is escaped.
- Rate limits sit on login and event submission.

## Production deployment and operations

I would run three images from this repository: API, worker, and nginx for the static UI. Postgres and Redis would be managed services, private to the network. More API replicas share the database constraint, Redis rate limits, and Redis pub/sub. More workers share the BullMQ queue; job ids and the receipt row keep notifications from doubling.

Configuration stays in the environment. `JWT_SECRET` would come from a secret manager and be at least 32 characters. Cookies would be `Secure` behind HTTPS. `TRUST_PROXY` would be true only behind the known ingress.

Health is `GET /health`. Readiness is `GET /ready`, which checks Postgres and Redis. The process handles `SIGINT` and `SIGTERM` by stopping new HTTP work, closing the queue, and closing the pool. Structured JSON logs include the request id. I would ship them to the platform log store, alert on 5xx rate, queue age, `failed_exhausted` deliveries, readiness failures, and disk or database saturation.

Backups: automated Postgres base backups plus WAL archiving, with a tested restore. Redis is a cache and a queue; a loss delays notifications, and the delivery table is enough to enqueue them again. Upload objects would use versioned, replicated object storage rather than a disk on the API node. Migrations are forward-only and applied before the new API serves traffic.

## Assumptions and trade-offs

- An owner can dispatch. The brief only requires owners to manage users; letting them operate the board matches a small maintenance company and keeps one permission path.
- Technicians submit progress only through the event API. Dispatchers change status through the work-order update. That keeps the idempotency rules on the technician path.
- scrypt in Node’s crypto module avoids a native password addon so installs work on Windows and Alpine. Argon2id would be my preference if a native build is acceptable.
- SSE instead of WebSockets because the browser sends the cookie without custom headers and reconnect is built in.
- The mock provider is deliberately controllable per organisation so a reviewer can show success, retry, and permanent failure without a third-party account.
- Offset pagination is fine for the interactive list. The export uses a keyset so a large file is not loaded into memory.
- Local standalone mode exists so the app can run where Docker is not installed. Compose is still the documented reviewer path.

## Known limitations or incomplete requirements

- The GitHub fork, the `assessment/shibin2002` branch, and the pull request are still to be opened. The final commit SHA cannot be written until that commit exists.
- Object storage, malware scanning, and a real notification provider are described above and not implemented.
- The realtime replay buffer is 50 events. Older gaps rely on the client refetch.
- If the process dies after the file is written and before the database commit, an unreferenced file can remain on disk. The download path will not serve it. A sweeper is not included.
- There is no password reset, email verification, or self-service profile edit.
- Interactive list pages use `OFFSET`. Very deep pages would get slower. Export does not.
- The test failpoint header exists only when `NODE_ENV=test`.
- Docker Compose and Postman were confirmed by the candidate on another machine. This workspace does not have the Docker CLI, so those two checks were not repeated here.
