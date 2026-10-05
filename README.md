# FieldDesk Full-Stack Engineering Assessment

This practical assessment is conducted by **Gatlier** to evaluate full-stack engineering ability, with particular emphasis on backend correctness, security, database design, testing and production awareness.

FieldDesk is a fictional field-service application created solely for this assessment. Candidates are expected to build a working application, explain their technical decisions and take ownership of everything they submit.

## Start here

1. Read the complete [assessment brief](docs/ASSESSMENT.md).
2. Review the [evaluation criteria](docs/EVALUATION.md).
3. Follow the [submission instructions](docs/SUBMISSION.md).
4. Complete the [technical notes](candidate-submission/TECHNICAL_NOTES.md) and [AI usage disclosure](candidate-submission/AI_USAGE.md).
5. Raise questions or blockers through a GitHub Issue in this repository.

## Run the application

The supported setup is Docker Compose. From the repository root:

```bash
docker compose up --build
```

Open http://localhost:8080. The API is also published on http://localhost:3000. Compose migrates and seeds on startup. The Compose `JWT_SECRET` is a local placeholder, not a production secret.

To run the processes on the host and only the data services in Docker:

```bash
docker compose up -d postgres redis
copy .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

Open http://localhost:5173. The Vite server proxies `/api` to the API, so the browser stays on one origin and the session cookies are sent.

On a Windows machine that already has PostgreSQL 17 and does not have Docker, `npm run dev:standalone` starts a disposable database cluster, Redis, the API, the worker, and the frontend. Docker Compose remains the setup a reviewer should use.

### Checks

```bash
npm test
npm run lint
npm run build
```

All three completed successfully on 5 October 2026. `npm test` passed 19 backend tests and 2 frontend tests. Lint reported no warnings. The API, worker, and frontend build completed.

`npm test` uses `DATABASE_URL` when it already points at a database named `fielddesk_test`, and `REDIS_URL` when it uses Redis database `/15`. Otherwise the test harness starts PostgreSQL and Redis itself. It refuses to truncate any database whose name is not `fielddesk_test`.

The running application was also checked over HTTP: health, readiness, sign-in, the dashboard, the work-order list, and the scheduling conflict on `NW-10421` all succeeded. The sign-in page returned HTTP 200 and does not display the seed password.

Docker Compose and the same API flows in Postman were run by the candidate on another machine and reported successful. `docker compose up --build` is the reviewer setup.

### Demo accounts

The sign-in screen does not show a password. These accounts exist only in the local seed data. Every one uses `FieldDesk-Assess-1`.

Do not commit `.env`, `uploads/`, or `.local/`. Those paths are listed in `.gitignore`. `.env.example` contains local placeholders only.

| Organisation | Email | Role |
| --- | --- | --- |
| Northwind Maintenance | owner@northwind.test | Owner |
| Northwind Maintenance | dispatcher@northwind.test | Dispatcher |
| Northwind Maintenance | alex.rivera@northwind.test | Technician |
| Northwind Maintenance | sam.patel@northwind.test | Technician |
| Harborline Services | owner@harborline.test | Owner |
| Harborline Services | dispatcher@harborline.test | Dispatcher |
| Harborline Services | rory.nguyen@harborline.test | Technician |

Alex Rivera is booked tomorrow 09:00–11:00 on `NW-10421`. Assigning that same window to `NW-10423` returns a scheduling conflict. Harborline cannot see Northwind jobs. Owners can switch the mock notification provider under Settings, then assign a job and watch the delivery attempts.

Design notes, failure behaviour, and limitations are in [candidate-submission/TECHNICAL_NOTES.md](candidate-submission/TECHNICAL_NOTES.md).

## Required stack

- React or Next.js with TypeScript
- Node.js with TypeScript
- PostgreSQL
- Redis with a suitable job queue
- Docker Compose

Libraries and architectural patterns are the candidate's choice. Significant decisions and trade-offs should be documented.

## What to submit

- A working frontend, API and background worker
- Database migrations and seed data
- Automated tests
- Docker-based local setup
- Clear technical documentation
- Completed submission templates
- A pull request from the candidate's fork
- A 10–15 minute screen recording
- The final commit SHA

AI-assisted development tools are permitted. Every use must be disclosed clearly, including the tools used, the files or sections affected, the purpose of the assistance and how the output was verified. The candidate remains responsible for the correctness, security and maintainability of all submitted work.

There is no prescribed visual design. A clear, usable interface is sufficient; engineering quality is the main consideration.

## Communication

Use GitHub Issues for all assessment questions, assumptions and technical blockers. This keeps clarifications visible and ensures every candidate receives consistent information.

Please do not include confidential information, credentials or code from a current or previous employer.

---

**Conducted by Gatlier**
