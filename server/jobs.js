import { z } from 'zod'
import { one } from './db.js'
import { permissions } from './auth.js'
import { count, dto, email, found, HttpError, id, jobStatus, money, quantity, routeId, search, text, validate } from './validation.js'

const jobList = search.extend({ status: jobStatus.optional() })
const vehicleFields = {
  registration_number: text(32), make: text(100), model: text(100),
  model_year: z.int().min(1886).max(new Date().getUTCFullYear() + 1).nullable().optional(),
  vin: z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/).nullable().optional(),
}
const customerFields = { full_name: text(), phone: text(40).nullable().optional(), email: email.nullable().optional() }
const jobFields = {
  vehicle_id: id, customer_id: id.optional(), mechanic_id: id.nullable().optional(),
  description: text(3000), odometer_km: count.nullable().optional(),
}
const pageSize = 20
export function page(rows, current) {
  return { items: rows.slice(0, pageSize), page: current, has_more: rows.length > pageSize }
}
export const paging = current => [pageSize + 1, (current - 1) * pageSize]

const jobSelect = `
  SELECT j.id, j.vehicle_id, j.customer_id, j.mechanic_id, j.status, j.description, j.odometer_km,
    j.opened_at, j.started_at, j.completed_at, v.registration_number, v.make, v.model,
    c.full_name AS customer_name, c.phone AS customer_phone, u.full_name AS mechanic_name
  FROM garage.jobs j JOIN garage.vehicles v ON v.id = j.vehicle_id
  JOIN garage.customers c ON c.id = j.customer_id LEFT JOIN garage.users u ON u.id = j.mechanic_id`
const assignedOnly = user => user.role_code === 'mechanic' ? user.id : null

async function ownJob(db, user, id, lock = false) {
  const sql = lock
    ? 'SELECT * FROM garage.jobs WHERE id = $1 AND ($2::bigint IS NULL OR mechanic_id = $2) FOR UPDATE'
    : jobSelect + ' WHERE j.id = $1 AND ($2::bigint IS NULL OR j.mechanic_id = $2)'
  return found(await one(db, sql, [id, assignedOnly(user)]), 'Job')
}

export function mountJobs(router, db) {
  const service = permissions('mechanic')

  router.get('/customers', permissions(), validate({ query: search }), async (req, res) => {
    const { q, page: current } = req.input.query
    const rows = await db.query(`SELECT * FROM garage.customers
      WHERE full_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    ['%' + q + '%', ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/customers', permissions(), validate({ body: dto(customerFields) }), async (req, res) => {
    const { full_name, phone, email } = req.input.body
    const customer = await one(db, 'INSERT INTO garage.customers (full_name, phone, email) VALUES ($1,$2,$3) RETURNING *',
      [full_name, phone ?? null, email ?? null])
    res.status(201).json(customer)
  })

  router.patch('/customers/:id', permissions(), validate({ params: routeId, body: dto(customerFields) }), async (req, res) => {
    const { full_name, phone, email } = req.input.body
    res.json(found(await one(db, 'UPDATE garage.customers SET full_name=$2, phone=$3, email=$4 WHERE id=$1 RETURNING *',
      [req.input.params.id, full_name, phone ?? null, email ?? null]), 'Customer'))
  })

  router.get('/vehicles', permissions(), validate({ query: search.extend({ customer_id: id.optional() }) }), async (req, res) => {
    const { q, page: current, customer_id } = req.input.query
    const rows = await db.query(`SELECT v.*, c.full_name AS customer_name FROM garage.vehicles v
      JOIN garage.customers c ON c.id=v.customer_id WHERE ($2::bigint IS NULL OR v.customer_id=$2)
      AND (v.registration_number ILIKE $1 OR v.make ILIKE $1 OR v.model ILIKE $1 OR c.full_name ILIKE $1)
      ORDER BY v.id DESC LIMIT $3 OFFSET $4`, ['%' + q + '%', customer_id ?? null, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/vehicles', permissions(), validate({ body: dto({ ...vehicleFields, customer_id: id }) }), async (req, res) => {
    const { customer_id, registration_number, make, model, model_year, vin } = req.input.body
    res.status(201).json(await one(db, `INSERT INTO garage.vehicles
      (customer_id, registration_number, make, model, model_year, vin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [customer_id, registration_number.toUpperCase(), make, model, model_year ?? null, vin ?? null]))
  })

  router.patch('/vehicles/:id', permissions(), validate({ params: routeId, body: dto({ ...vehicleFields, customer_id: id }) }), async (req, res) => {
    const { customer_id, registration_number, make, model, model_year, vin } = req.input.body
    res.json(found(await one(db, `UPDATE garage.vehicles SET customer_id=$2, registration_number=$3, make=$4,
      model=$5, model_year=$6, vin=$7 WHERE id=$1 RETURNING *`,
    [req.input.params.id, customer_id, registration_number.toUpperCase(), make, model, model_year ?? null, vin ?? null]), 'Vehicle'))
  })

  router.get('/mechanics', permissions(), validate(), async (req, res) => {
    res.json(await db.query(`SELECT id, full_name FROM garage.users
      WHERE role_code='mechanic' AND is_active ORDER BY full_name, id`))
  })

  router.get('/jobs', service, validate({ query: jobList }), async (req, res) => {
    const { q, page: current, status } = req.input.query
    const rows = await db.query(jobSelect + `
      WHERE ($2::bigint IS NULL OR j.mechanic_id=$2) AND ($3::garage.job_status IS NULL OR j.status=$3)
        AND (v.registration_number ILIKE $1 OR c.full_name ILIKE $1 OR j.description ILIKE $1 OR j.id::text=$4)
      ORDER BY j.opened_at DESC, j.id DESC LIMIT $5 OFFSET $6`,
    ['%' + q + '%', assignedOnly(req.user), status ?? null, q, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/jobs', permissions(), validate({ body: dto(jobFields) }), async (req, res) => {
    const { vehicle_id, customer_id, mechanic_id, description, odometer_km } = req.input.body
    const job = await one(db, `INSERT INTO garage.jobs (vehicle_id,customer_id,created_by,mechanic_id,description,odometer_km)
      SELECT id,coalesce($2,customer_id),$3,$4,$5,$6 FROM garage.vehicles WHERE id=$1 RETURNING id`,
    [vehicle_id, customer_id ?? null, req.user.id, mechanic_id ?? null, description, odometer_km ?? null])
    res.status(201).json(found(job, 'Vehicle'))
  })

  router.get('/jobs/:id', service, validate({ params: routeId }), async (req, res) => {
    const jobId = req.input.params.id
    const job = await ownJob(db, req.user, jobId)
    const [notes, labor, requests, history, invoice] = await Promise.all([
      db.query(`SELECT n.id, n.body, n.created_at, u.full_name AS author FROM garage.service_notes n
        JOIN garage.users u ON u.id=n.author_id WHERE n.job_id=$1 ORDER BY n.created_at DESC, n.id DESC`, [jobId]),
      db.query('SELECT id, description, amount FROM garage.job_labor WHERE job_id=$1 ORDER BY id', [jobId]),
      db.query(`SELECT r.id, r.quantity,r.status,r.requested_at,p.name,p.sku FROM garage.part_requests r
        JOIN garage.parts p ON p.id=r.part_id WHERE r.job_id=$1 ORDER BY r.id DESC`, [jobId]),
      db.query(`SELECT h.status,h.changed_at,u.full_name AS changed_by FROM garage.job_status_history h
        JOIN garage.users u ON u.id=h.changed_by WHERE h.job_id=$1 ORDER BY h.id`, [jobId]),
      req.user.role_code === 'admin' ? one(db, 'SELECT id FROM garage.invoices WHERE job_id=$1', [jobId]) : null,
    ])
    res.json({ ...job, notes, labor, requests, history, ...(invoice && { invoice_id: invoice.id }) })
  })

  router.patch('/jobs/:id/assignment', permissions(), validate({ params: routeId, body: dto({ mechanic_id: id.nullable() }) }), async (req, res) => {
    res.json(found(await one(db, 'UPDATE garage.jobs SET mechanic_id=$2 WHERE id=$1 RETURNING id',
      [req.input.params.id, req.input.body.mechanic_id]), 'Job'))
  })

  router.patch('/jobs/:id/status', service, validate({ params: routeId, body: dto({ status: jobStatus }) }), async (req, res) => {
    const { id } = req.input.params
    const { status } = req.input.body
    const result = await db.transaction(async manager => {
      const job = await ownJob(manager, req.user, id, true)
      if (job.status === status) return { id, status }
      return one(manager, 'UPDATE garage.jobs SET status=$2, status_changed_by=$3 WHERE id=$1 RETURNING id,status', [id, status, req.user.id])
    })
    res.json(result)
  })

  const jobCreate = (path, body, sql, params) => router.post('/jobs/:id/' + path, service,
    validate({ params: routeId, body }), async (req, res) => {
      const { id } = req.input.params
      const result = await db.transaction(async manager => {
        await ownJob(manager, req.user, id, true)
        return one(manager, sql, [id, req.user.id, ...params(req.input.body)])
      })
      res.status(201).json(found(result, "Record"))
    })

  jobCreate('notes', dto({ body: text(5000) }),
    'INSERT INTO garage.service_notes (job_id,author_id,body) VALUES ($1,$2,$3) RETURNING id', body => [body.body])

  jobCreate('labor', dto({ description: text(1000), amount: money }),
    'INSERT INTO garage.job_labor (job_id,recorded_by,description,amount) VALUES ($1,$2,$3,$4) RETURNING id',
    body => [body.description, body.amount])

  jobCreate('parts', dto({ part_id: id, quantity }),
    `INSERT INTO garage.part_requests (job_id,requested_by,part_id,quantity)
      SELECT $1,$2,id,$4 FROM garage.parts WHERE id=$3 AND is_active RETURNING id`,
    body => [body.part_id, body.quantity])

  router.patch('/jobs/:id/parts/:requestId', service,
    validate({ params: dto({ id, requestId: id }), body: dto({ status: z.literal('cancelled') }) }), async (req, res) => {
      const { id, requestId } = req.input.params
      // Lock requests before their job, as the stock fulfillment trigger does.
      const result = await db.transaction(async manager => {
        const request = found(await one(manager, 'SELECT id,status FROM garage.part_requests WHERE id=$1 AND job_id=$2 FOR UPDATE',
          [requestId, id]), 'Parts request')
        await ownJob(manager, req.user, id, true)
        if (request.status !== 'pending') throw new HttpError(409, 'Only pending requests can be cancelled.')
        return one(manager, `UPDATE garage.part_requests SET status='cancelled',resolved_by=$2 WHERE id=$1 RETURNING id,status`,
          [requestId, req.user.id])
      })
      res.json(result)
    })
}
