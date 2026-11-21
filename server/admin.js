import { ILike } from 'typeorm'
import { z } from 'zod'
import { hashPassword, permissions } from './auth.js'
import { financeReport } from './billing.js'
import { one } from './db.js'
import { page, paging } from './jobs.js'
import { dto, email, found, HttpError, id, password, roles, routeId, search, text, validate, windowQuery } from './validation.js'

const profile = { full_name: text(), email, role_code: roles }
const feedbackStatus = z.enum(['open', 'in_review', 'resolved'])

export function mountAdmin(router, db) {
  const admin = permissions()

  router.get('/users', admin, validate({ query: search }), async (req, res) => {
    const { q, page: current } = req.input.query
    const [take, skip] = paging(current)
    const like = ILike('%' + q + '%')
    const users = await db.getRepository('User').find({
      where: [{ full_name: like }, { email: like }],
      order: { id: 'DESC' }, take, skip,
    })
    res.json(page(users, current))
  })

  router.post('/users', admin, validate({ body: dto({ ...profile, password }) }), async (req, res) => {
    const { full_name, email, role_code, password } = req.input.body
    const result = await one(db, `INSERT INTO garage.users (full_name,email,role_code,password_hash)
      VALUES ($1,$2,$3,$4) RETURNING id,full_name,email,role_code,is_active`,
    [full_name, email, role_code, await hashPassword(password)])
    res.status(201).json(result)
  })

  router.patch('/users/:id', admin, validate({
    params: routeId, body: dto({ ...profile, is_active: z.boolean(), password: password.optional() }),
  }), async (req, res) => {
    const { id } = req.input.params
    const { full_name, email, role_code, is_active, password } = req.input.body
    if (id === req.user.id && (role_code !== 'admin' || !is_active)) {
      throw new HttpError(409, 'You can only change your own name, email, or password.')
    }
    const newHash = password ? await hashPassword(password) : null
    const result = await db.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(8904271)')
      const actingAdmin = await one(manager, "SELECT id FROM garage.users WHERE id=$1 AND role_code='admin' AND is_active", [req.user.id])
      if (!actingAdmin) throw new HttpError(403, 'This operation requires an active administrator.')
      const existing = found(await one(manager, `SELECT role_code,is_active FROM garage.users WHERE id=$1 FOR UPDATE`, [id]), 'User')
      const result = await one(manager, `UPDATE garage.users SET full_name=$2,email=$3,role_code=$4,is_active=$5,
        password_hash=coalesce($6,password_hash) WHERE id=$1 RETURNING id,full_name,email,role_code,is_active`,
      [id, full_name, email, role_code, is_active, newHash])
      if (password || role_code !== existing.role_code || is_active !== existing.is_active) {
        await manager.query(`DELETE FROM garage.user_sessions WHERE user_id=$1 AND token_hash IS DISTINCT FROM $2`,
          [id, id === req.user.id ? req.sessionHash : null])
      }
      return result
    })
    res.json(result)
  })

  router.get('/feedback', admin, validate({ query: search.extend({ status: feedbackStatus.optional() }) }), async (req, res) => {
    const { q, page: current, status } = req.input.query
    const rows = await db.query(`SELECT f.*,c.full_name AS customer_name,v.registration_number,u.full_name AS logged_by_name
      FROM garage.feedback f JOIN garage.jobs j ON j.id=f.job_id JOIN garage.customers c ON c.id=j.customer_id
      JOIN garage.vehicles v ON v.id=j.vehicle_id JOIN garage.users u ON u.id=f.logged_by
      WHERE ($2::garage.feedback_status IS NULL OR f.status=$2)
      AND (c.full_name ILIKE $1 OR v.registration_number ILIKE $1 OR f.comments ILIKE $1)
      ORDER BY f.logged_at DESC,f.id DESC LIMIT $3 OFFSET $4`, ['%' + q + '%', status ?? null, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/feedback', admin, validate({
    body: dto({ job_id: id, rating: z.int().min(1).max(5).optional(), comments: text(5000).optional(), is_complaint: z.boolean() })
      .refine(body => body.comments || (!body.is_complaint && body.rating), 'Add a rating or comments. Complaints require comments.'),
  }), async (req, res) => {
    const { job_id, rating, comments, is_complaint } = req.input.body
    res.status(201).json(await one(db, `INSERT INTO garage.feedback (job_id,rating,comments,is_complaint,logged_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [job_id, rating ?? null, comments ?? null, is_complaint, req.user.id]))
  })

  router.patch('/feedback/:id', admin, validate({
    params: routeId, body: z.union([dto({ status: z.enum(['open', 'in_review']) }), dto({ status: z.literal('resolved'), resolution_notes: text(5000) })]),
  }), async (req, res) => {
    const { status, resolution_notes } = req.input.body
    res.json(found(await one(db, `UPDATE garage.feedback SET status=$2::garage.feedback_status,resolution_notes=$3,
      resolved_by=CASE WHEN $2::garage.feedback_status='resolved' THEN $4::bigint ELSE NULL END,
      resolved_at=CASE WHEN $2::garage.feedback_status='resolved' THEN now() ELSE NULL END WHERE id=$1 RETURNING id,status`,
    [req.input.params.id, status, resolution_notes ?? null, req.user.id]), 'Feedback'))
  })

  router.get('/analytics', admin, validate({ query: windowQuery }), async (req, res) => {
    const [finance, jobs, stock, alerts, parts, mechanics, recent] = await Promise.all([
      financeReport(db, req.input.query.months),
      one(db, `SELECT count(*) FILTER (WHERE status='completed') AS completed,
        count(*) FILTER (WHERE status='in_progress') AS in_progress,
        count(*) FILTER (WHERE status='pending') AS pending FROM garage.jobs`),
      one(db, `SELECT count(*) AS low, count(*) FILTER (WHERE out_of_stock) AS out_of_stock FROM garage.low_stock_alerts`),
      db.query('SELECT * FROM garage.low_stock_alerts ORDER BY stock_quantity, name LIMIT 6'),
      db.query('SELECT * FROM garage.top_selling_parts ORDER BY units_sold DESC, name LIMIT 5'),
      db.query('SELECT * FROM garage.mechanic_performance ORDER BY completed_jobs DESC, full_name LIMIT 5'),
      db.query(`SELECT j.id,j.status,j.opened_at,v.registration_number,v.make,v.model,c.full_name AS customer_name,
        u.full_name AS mechanic_name FROM garage.jobs j JOIN garage.vehicles v ON v.id=j.vehicle_id
        JOIN garage.customers c ON c.id=j.customer_id LEFT JOIN garage.users u ON u.id=j.mechanic_id
        ORDER BY j.opened_at DESC,j.id DESC LIMIT 5`),
    ])
    res.json({ finance, jobs, stock, alerts, parts, mechanics, recent })
  })
}
