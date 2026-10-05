import { beforeAll, beforeEach, expect, it } from 'vitest'
import { createOrganisation, createUser, db, getApp, password, resetDatabase, Session } from './helpers'

beforeAll(async () => {
  await getApp()
})

beforeEach(async () => {
  await resetDatabase()
})

it('signs in, reads the session, and rejects a bad password', async () => {
  const app = await getApp()
  const org = await createOrganisation('Northwind')
  const dispatcher = await createUser(org, 'dispatcher', 'dispatcher@northwind.test')
  const session = new Session(app)
  const success = await session.login(dispatcher.email)
  expect(success.json().user.email).toBe(dispatcher.email)
  expect(success.headers['set-cookie']).toBeTruthy()

  const me = await session.request('GET', '/api/auth/me')
  expect(me.statusCode).toBe(200)
  expect(me.json().user.role).toBe('dispatcher')

  const missing = await new Session(app).request('GET', '/api/work-orders')
  expect(missing.statusCode).toBe(401)

  const wrong = await new Session(app).request('POST', '/api/auth/login', {
    email: dispatcher.email,
    password: 'not-the-password',
  })
  const unknown = await new Session(app).request('POST', '/api/auth/login', {
    email: 'nobody@northwind.test',
    password,
  })
  expect(wrong.statusCode).toBe(401)
  expect(unknown.statusCode).toBe(401)
  expect(wrong.json().error.message).toBe(unknown.json().error.message)
  expect(wrong.json().error.requestId).toBeTruthy()

  await db(`UPDATE users SET disabled_at = now() WHERE id = $1`, [dispatcher.id])
  const disabled = await new Session(app).request('POST', '/api/auth/login', {
    email: dispatcher.email,
    password,
  })
  expect(disabled.statusCode).toBe(401)
  const afterDisable = await session.request('GET', '/api/auth/me')
  expect(afterDisable.statusCode).toBe(401)
})

it('rejects cookie mutations that omit the CSRF header', async () => {
  const app = await getApp()
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'dispatcher@northwind.test', password },
  })
  expect(response.statusCode).toBe(403)
  expect(response.json().error.code).toBe('CSRF_REJECTED')
})

it('reports liveness and readiness', async () => {
  const app = await getApp()
  expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200)
  expect((await app.inject({ method: 'GET', url: '/ready' })).json().status).toBe('ready')
})

it('logs out and refuses the next authenticated request', async () => {
  const app = await getApp()
  const org = await createOrganisation('Northwind')
  const owner = await createUser(org, 'owner')
  const session = new Session(app)
  await session.login(owner.email)
  const loggedOut = await session.request('POST', '/api/auth/logout')
  expect(loggedOut.statusCode).toBe(200)
  const me = await session.request('GET', '/api/auth/me')
  expect(me.statusCode).toBe(401)
})
