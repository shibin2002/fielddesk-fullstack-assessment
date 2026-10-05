# AI usage disclosure

Complete this document honestly. It is not assessed as a coding exercise, but an incomplete or inaccurate disclosure affects the assessment.

## Tools used

- Tool: Cursor, with the Grok 4.7 coding agent
- Model, if known: Grok 4.7
- Date used: 5 October 2026

## What the AI was asked to do

The agent was asked to read this repository’s README and implement the FieldDesk assessment: a multi-tenant field-service application with the required repository layout, a working UI, and automated tests. The request was to follow `docs/ASSESSMENT.md`, `docs/EVALUATION.md`, and `docs/SUBMISSION.md`.

The agent planned the schema, API, worker, frontend, Docker setup, and tests, then wrote the implementation in this workspace. It was also asked to keep the original Gatlier README introduction and to add run instructions, technical notes, and this disclosure.

## What the AI generated or materially changed

The agent generated essentially the whole implementation. In particular:

- `database/migrations/001_init.sql`, including the exclusion constraint, immutability triggers, and indexes
- `backend/src`, including authentication, work orders, scheduling, progress events, attachments, audit, CSV export, realtime, and health checks
- `worker/src`, including retries, the mock provider, and recovery of pending deliveries
- `frontend/src` and `frontend/src/styles.css`
- `tests`, the Vitest configuration, and the local PostgreSQL/Redis test harness
- `docker-compose.yml`, the three Dockerfiles, and `frontend/nginx.conf`
- `.env.example` and the run section added to `README.md`
- `scripts/standalone.ts`
- this file and `candidate-submission/TECHNICAL_NOTES.md`

The agent also ran the TypeScript compiler, the test suite, and fixed the failures it found: the reference-number counter colliding with a seeded job, an attachment quota fixture that was under the limit, a realtime test that never finished because `fetch` waited for the stream to close, and a form test whose label text included the validation message.

## What the candidate wrote or changed personally

shibin (GitHub `shibin2002`) directed the work, reviewed the application, and recorded the walkthrough: https://drive.google.com/file/d/1Zx9c-ztLhD4I2-3xn_iOcCSmILFnqVo0/view?usp=drive_link

The candidate also replaced the GitHub username placeholders in `docs/SUBMISSION.md` with `shibin2002`. The application source was produced by the agent.

## How the output was reviewed and verified

The agent compiled the backend, worker, and frontend, ran the backend and frontend test suites, and fixed the failures those runs produced. Tests cover authentication, role boundaries, cross-organisation access, concurrent scheduling against the database constraint, duplicate and rolled-back progress events, attachment type and quota checks, CSV tenant scope and formula escaping, realtime tenant scope, and notification retries.

On 5 October 2026, `npm test`, `npm run lint`, and `npm run build` passed. Against the running app, health, readiness, owner login, the dashboard, the work-order list, and the Alex Rivera scheduling conflict all succeeded. The FieldDesk page returned HTTP 200.

The candidate recorded the 10–15 minute walkthrough linked above. On another machine, the candidate ran `docker compose up --build` and the same API flows in Postman, and reported both successful. This workspace does not have the Docker CLI, so those two checks were not repeated here.

## Candidate confirmation

- [x] I understand the submitted solution and can explain its design.
- [x] I verified the behaviour described in the technical notes.
- [x] I accept responsibility for the submitted code, including AI-generated portions.
