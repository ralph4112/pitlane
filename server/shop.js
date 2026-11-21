import { z } from 'zod'
import { one } from './db.js'
import { permissions } from './auth.js'
import { page, paging } from './jobs.js'
import { count, dto, email, found, HttpError, id, money, routeId, search, text, validate } from './validation.js'

const supplierFields = {
  name: text(), contact_name: text().nullable().optional(), email: email.nullable().optional(),
  phone: text(40).nullable().optional(), address: text(500).nullable().optional(),
}
const partFields = {
  sku: text(60), name: text(), description: text(1000).nullable().optional(),
  supplier_id: id.nullable().optional(), unit_cost: money, unit_price: money,
  reorder_threshold: count, is_active: z.boolean().optional().default(true),
}
const supplierValues = body => [body.name, body.contact_name ?? null, body.email ?? null, body.phone ?? null, body.address ?? null]
const partValues = body => [
  body.sku.toUpperCase(), body.name, body.description ?? null, body.supplier_id ?? null,
  body.unit_cost, body.unit_price, body.reorder_threshold, body.is_active,
]

export function mountShop(router, db) {
  const shop = permissions('shop_manager')

  router.get('/part-options', permissions('shop_manager', 'mechanic'), validate({ query: search }), async (req, res) => {
    const { q, page: current } = req.input.query
    const rows = await db.query(`SELECT id,name,sku,stock_quantity FROM garage.parts
      WHERE is_active AND (name ILIKE $1 OR sku ILIKE $1)
      ORDER BY name, id LIMIT $2 OFFSET $3`, ['%' + q + '%', ...paging(current)])
    res.json(page(rows, current))
  })

  router.get('/suppliers', shop, validate({ query: search }), async (req, res) => {
    const { q, page: current } = req.input.query
    const rows = await db.query(`SELECT * FROM garage.suppliers WHERE name ILIKE $1 OR contact_name ILIKE $1
      ORDER BY name,id LIMIT $2 OFFSET $3`, ['%' + q + '%', ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/suppliers', shop, validate({ body: dto(supplierFields) }), async (req, res) => {
    res.status(201).json(await one(db, `INSERT INTO garage.suppliers (name,contact_name,email,phone,address)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, supplierValues(req.input.body)))
  })

  router.patch('/suppliers/:id', shop, validate({ params: routeId, body: dto(supplierFields) }), async (req, res) => {
    res.json(found(await one(db, `UPDATE garage.suppliers SET name=$2,contact_name=$3,email=$4,phone=$5,address=$6
      WHERE id=$1 RETURNING *`, [req.input.params.id, ...supplierValues(req.input.body)]), 'Supplier'))
  })

  router.get('/parts', shop, validate({ query: search.extend({ stock: z.enum(['low', 'active']).optional() }) }), async (req, res) => {
    const { q, page: current, stock } = req.input.query
    const rows = await db.query(`SELECT p.*,s.name AS supplier_name FROM garage.parts p LEFT JOIN garage.suppliers s ON s.id=p.supplier_id
      WHERE (p.name ILIKE $1 OR p.sku ILIKE $1 OR s.name ILIKE $1) AND ($2::text IS NULL OR (p.is_active AND
        ($2='active' OR p.stock_quantity<=p.reorder_threshold)))
      ORDER BY p.name,p.id LIMIT $3 OFFSET $4`, ['%' + q + '%', stock ?? null, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/parts', shop, validate({ body: dto(partFields) }), async (req, res) => {
    res.status(201).json(await one(db, `INSERT INTO garage.parts (sku,name,description,supplier_id,unit_cost,unit_price,reorder_threshold,is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, partValues(req.input.body)))
  })

  router.patch('/parts/:id', shop, validate({ params: routeId, body: dto(partFields) }), async (req, res) => {
    res.json(found(await one(db, `UPDATE garage.parts SET sku=$2,name=$3,description=$4,supplier_id=$5,
      unit_cost=$6,unit_price=$7,reorder_threshold=$8,is_active=$9 WHERE id=$1 RETURNING *`,
    [req.input.params.id, ...partValues(req.input.body)]), 'Part'))
  })

  router.get('/parts/:id/movements', shop, validate({ params: routeId, query: search.omit({ q: true }) }), async (req, res) => {
    const current = req.input.query.page
    const rows = await db.query(`SELECT m.id,m.quantity_delta,m.reason,m.recorded_at,u.full_name AS recorded_by
      FROM garage.stock_movements m JOIN garage.users u ON u.id=m.recorded_by WHERE m.part_id=$1
      ORDER BY m.id DESC LIMIT $2 OFFSET $3`, [req.input.params.id, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/parts/:id/movements', shop, validate({
    params: routeId, body: dto({ quantity_delta: z.int().min(-1000000).max(1000000).refine(value => value !== 0), reason: text(500) }),
  }), async (req, res) => {
    const { quantity_delta, reason } = req.input.body
    const movement = await db.transaction(async manager => {
      const saved = await one(manager, `INSERT INTO garage.stock_movements (part_id,quantity_delta,reason,recorded_by)
        VALUES ($1,$2,$3,$4) RETURNING id`, [req.input.params.id, quantity_delta, reason, req.user.id])
      const stock = await one(manager, 'SELECT stock_quantity FROM garage.parts WHERE id=$1', [req.input.params.id])
      return { ...saved, ...stock }
    })
    res.status(201).json(movement)
  })

  router.get('/parts-requests', shop, validate({
    query: search.extend({ status: z.enum(['pending', 'fulfilled', 'rejected', 'cancelled']).optional() }),
  }), async (req, res) => {
    const { q, page: current, status } = req.input.query
    const rows = await db.query(`SELECT r.id, r.job_id,r.quantity,r.status,r.requested_at,p.name,p.sku,p.stock_quantity,
      v.registration_number,u.full_name AS requested_by FROM garage.part_requests r
      JOIN garage.parts p ON p.id=r.part_id JOIN garage.jobs j ON j.id=r.job_id JOIN garage.vehicles v ON v.id=j.vehicle_id
      JOIN garage.users u ON u.id=r.requested_by WHERE ($2::garage.request_status IS NULL OR r.status=$2)
      AND (p.name ILIKE $1 OR p.sku ILIKE $1 OR v.registration_number ILIKE $1 OR u.full_name ILIKE $1)
      ORDER BY (r.status='pending') DESC,r.requested_at DESC,r.id DESC LIMIT $3 OFFSET $4`,
    ['%' + q + '%', status ?? null, ...paging(current)])
    res.json(page(rows, current))
  })

  router.patch('/parts-requests/:id', shop, validate({ params: routeId, body: dto({ status: z.enum(['fulfilled', 'rejected']) }) }), async (req, res) => {
    const result = await one(db, `UPDATE garage.part_requests SET status=$2,resolved_by=$3
      WHERE id=$1 AND status='pending' RETURNING id,status`, [req.input.params.id, req.input.body.status, req.user.id])
    if (!result) throw new HttpError(409, 'This parts request is unavailable or has already been resolved.')
    res.json(result)
  })
}
