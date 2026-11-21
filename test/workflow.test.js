import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { createApp } from '../server/app.js'
import { hashPassword } from '../server/auth.js'
import { dataSource, one } from '../server/db.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test('garage workflow and role boundaries', { skip: !databaseUrl && 'Set TEST_DATABASE_URL to an initialized, disposable database.' }, async context => {
  const db = await dataSource(databaseUrl).initialize()
  const server = createApp(db).listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await db.destroy()
  })

  const base = 'http://127.0.0.1:' + server.address().port
  const fixture = randomBytes(4).toString('hex')
  const password = randomBytes(18).toString('hex')
  const owner = { email: `owner-${fixture}@example.test`, password }
  await one(db, `INSERT INTO garage.users (role_code,full_name,email,password_hash)
    VALUES ('admin',$1,$2,$3) RETURNING id`, ['Test Owner', owner.email, await hashPassword(password)])

  async function call(path, { method = 'GET', data, cookie, status = 200, headers = {} } = {}) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { ...headers, ...(cookie && { cookie }), ...(data !== undefined && { 'Content-Type': 'application/json' }) },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    })
    const body = response.status === 204 ? null : await response.json()
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(body)}`)
    return { body, headers: response.headers }
  }

  function client(cookie) {
    return {
      get: async (path, status) => (await call(path, { cookie, status })).body,
      post: async (path, data, status = 201) => (await call(path, { method: 'POST', data, cookie, status })).body,
      patch: async (path, data, status = 200) => (await call(path, { method: 'PATCH', data, cookie, status })).body,
      delete: async (path, status = 204) => call(path, { method: 'DELETE', cookie, status }),
      cookie,
    }
  }

  async function signIn(credentials) {
    const response = await call('/auth/login', { method: 'POST', data: credentials })
    const cookie = response.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Strict/i)
    assert.equal(response.body.password_hash, undefined)
    return client(cookie.split(';')[0])
  }

  await call('/jobs', { status: 401 })
  await call('/auth/login', { method: 'POST', data: owner, headers: { origin: 'https://example.test' }, status: 403 })
  await call('/auth/login', { method: 'POST', data: { ...owner, role_code: 'admin' }, status: 400 })
  const admin = await signIn(owner)

  async function createUser(role_code, suffix = role_code) {
    const credentials = { email: `${suffix}-${fixture}@example.test`, password }
    const profile = await admin.post('/users', { ...credentials, full_name: 'Test ' + suffix, role_code })
    return { ...profile, client: await signIn(credentials) }
  }

  const mechanic = await createUser('mechanic')
  const other = await createUser('mechanic', 'other')
  const shop = await createUser('shop_manager')
  const cashier = await createUser('accountant')
  await mechanic.client.get('/analytics', 403)
  await shop.client.get('/reports/finance', 403)
  await cashier.client.get('/parts', 403)
  await admin.get('/jobs/invalid-id', 400)
  await admin.get('/jobs?unexpected=yes', 400)
  assert((await admin.get('/users?q=' + fixture)).items.every(user => !('password_hash' in user)))

  const customer = await admin.post('/customers', { full_name: 'Customer ' + fixture, phone: '+254700000000' })
  const vehicle = await admin.post('/vehicles', { customer_id: customer.id, registration_number: fixture, make: 'Toyota', model: 'Corolla' })
  const job = await admin.post('/jobs', { vehicle_id: vehicle.id, mechanic_id: mechanic.id, description: 'Full service', odometer_km: 78000 })
  assert.equal((await other.client.get('/jobs')).items.length, 0)
  await other.client.get('/jobs/' + job.id, 404)
  await other.client.post(`/jobs/${job.id}/notes`, { body: 'Outside assignment' }, 404)

  const supplier = await shop.client.post('/suppliers', { name: 'Supplier ' + fixture })
  const part = await shop.client.post('/parts', { sku: fixture, name: 'Oil filter', supplier_id: supplier.id, unit_cost: '80', unit_price: '125.50', reorder_threshold: 2 })
  await shop.client.post(`/parts/${part.id}/movements`, { quantity_delta: 4, reason: 'Initial delivery' })
  await mechanic.client.patch(`/jobs/${job.id}/status`, { status: 'in_progress' })
  await mechanic.client.post(`/jobs/${job.id}/notes`, { body: 'Replaced worn filter.' })
  await mechanic.client.post(`/jobs/${job.id}/labor`, { description: 'Service labor', amount: '500' })
  const request = await mechanic.client.post(`/jobs/${job.id}/parts`, { part_id: part.id, quantity: 2 })
  await mechanic.client.patch(`/jobs/${job.id}/status`, { status: 'completed' }, 409)
  await shop.client.patch('/parts-requests/' + request.id, { status: 'fulfilled' })
  await mechanic.client.patch(`/jobs/${job.id}/status`, { status: 'completed' })
  const detail = await mechanic.client.get('/jobs/' + job.id)
  assert.equal(detail.history.length, 3)
  assert.equal(detail.notes.length, 1)
  assert.equal(detail.requests[0].status, 'fulfilled')

  const feedback = await admin.post('/feedback', { job_id: job.id, rating: 4, comments: 'Long wait', is_complaint: true })
  await admin.patch('/feedback/' + feedback.id, { status: 'resolved', resolution_notes: 'Contacted customer.' })
  assert.equal((await admin.get('/feedback?q=Long%20wait&status=resolved')).items.find(item => item.id === feedback.id).status, 'resolved')

  assert((await cashier.client.get('/billable-jobs?q=' + fixture)).items.some(row => row.id === job.id))
  const invoice = await cashier.client.post('/invoices/service', { job_id: job.id })
  const draft = await cashier.client.get('/invoices/' + invoice.id)
  assert.equal(draft.total, '751.00')
  const labor = draft.lines[0]
  await cashier.client.patch(`/invoices/${invoice.id}/lines/${labor.id}/price`, { unit_price: '450', reason: 'Adjustment' }, 403)
  await admin.patch(`/invoices/${invoice.id}/lines/${labor.id}/price`, { unit_price: '450', reason: 'Adjustment' })
  await cashier.client.post(`/invoices/${invoice.id}/issue`, undefined, 200)
  await shop.client.get('/invoices/' + invoice.id, 404)
  let issued = await cashier.client.get('/invoices/' + invoice.id)
  assert.equal(issued.total, '701.00')
  assert.equal(issued.payment_status, 'unpaid')
  await admin.patch(`/invoices/${invoice.id}/lines/${labor.id}/price`, { unit_price: null }, 409)

  const payment = { amount: '201', method: 'mobile_money', idempotency_key: randomUUID() }
  const posted = await cashier.client.post(`/invoices/${invoice.id}/payments`, payment)
  assert.deepEqual(await cashier.client.post(`/invoices/${invoice.id}/payments`, payment, 200), posted)
  await cashier.client.patch('/payments/' + posted.id, { status: 'confirmed' })
  assert.equal((await cashier.client.get('/receipts/' + posted.id)).amount, '201.00')
  assert.equal((await cashier.client.get('/invoices/' + invoice.id)).payment_status, 'partial')
  const settle = amount => ({ amount, method: 'cash', idempotency_key: randomUUID(), confirm: true })
  await cashier.client.post(`/invoices/${invoice.id}/payments`, settle('501'), 409)
  const competing = await Promise.all(['500', '500'].map(amount => fetch(base + `/api/invoices/${invoice.id}/payments`, {
    method: 'POST', headers: { cookie: cashier.client.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(settle(amount)),
  })))
  assert.deepEqual(competing.map(result => result.status).sort(), [201, 409])
  issued = await cashier.client.get('/invoices/' + invoice.id)
  assert.equal(issued.payment_status, 'paid')
  assert.equal(issued.payments.length, 2)

  const sale = await shop.client.post('/invoices/shop', { lines: [{ part_id: part.id, quantity: 2 }] })
  assert.equal((await shop.client.get('/invoices?kind=shop_sale')).items.find(item => item.id === sale.id).kind, 'shop_sale')
  await cashier.client.post(`/invoices/${sale.id}/issue`, undefined, 403)
  await shop.client.post(`/invoices/${sale.id}/issue`, undefined, 200)
  const oversold = await shop.client.post('/invoices/shop', { lines: [{ part_id: part.id, quantity: 1 }] })
  await shop.client.post(`/invoices/${oversold.id}/issue`, undefined, 409)
  await shop.client.delete('/invoices/' + oversold.id)
  const stock = (await shop.client.get('/parts?stock=low&q=' + fixture)).items[0]
  assert.equal(stock.stock_quantity, 0)
  assert.equal((await shop.client.get(`/parts/${part.id}/movements`)).items.length, 3)
  assert.equal((await cashier.client.get('/reports/finance?months=6')).revenue.length, 6)
  assert.equal((await admin.get('/analytics?months=12')).finance.revenue.length, 12)
  await other.client.post('/auth/logout', undefined, 204)
  await other.client.get('/auth/me', 401)

  await admin.patch('/users/' + mechanic.id, {
    full_name: mechanic.full_name, email: mechanic.email, role_code: 'shop_manager', is_active: true,
  })
  await mechanic.client.get('/auth/me', 401)
})
