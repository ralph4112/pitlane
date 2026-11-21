import { z } from 'zod'
import { one } from './db.js'
import { permissions } from './auth.js'
import { page, paging } from './jobs.js'
import {
  dto, found, HttpError, id, invoiceFilter, money, paymentMethod, positiveMoney, quantity, routeId, search, text, validate, windowQuery,
} from './validation.js'

const serviceDraft = dto({ job_id: id })
const saleDraft = dto({
  bill_to_name: text().optional(), bill_to_contact: text(254).optional(),
  lines: z.array(dto({ part_id: id, quantity })).min(1).max(100),
})
const paymentFields = dto({
  amount: positiveMoney, method: paymentMethod, external_reference: text().optional(),
  idempotency_key: z.uuid(), confirm: z.boolean().optional().default(false),
})
const overrideFields = z.union([dto({ unit_price: money, reason: text(500) }), dto({ unit_price: z.null() })])
const shopScope = user => user.role_code === 'shop_manager' ? 'shop_sale' : null

const invoiceSelect = `SELECT i.id,i.kind,i.job_id,i.currency,i.created_at,i.issued_at,
  coalesce(i.bill_to_name,c.full_name,'Walk-in customer') AS bill_to_name,i.bill_to_contact,
  b.invoice_number,b.payment_status,b.paid_amount,b.balance_due,
  coalesce(b.total,(SELECT sum(line_total) FROM garage.invoice_lines WHERE invoice_id=i.id),0) AS total
  FROM garage.invoices i LEFT JOIN garage.invoice_balances b ON b.invoice_id=i.id
  LEFT JOIN garage.customers c ON c.id=i.customer_id`

async function accessibleInvoice(db, user, id, lock = false) {
  const sql = lock
    ? 'SELECT id,kind,issued_at FROM garage.invoices WHERE id=$1 AND ($2::garage.invoice_kind IS NULL OR kind=$2) FOR UPDATE'
    : invoiceSelect + ' WHERE i.id=$1 AND ($2::garage.invoice_kind IS NULL OR i.kind=$2)'
  return found(await one(db, sql, [id, shopScope(user)]), 'Invoice')
}

export function mountBilling(router, db) {
  const finance = permissions('accountant')
  const shop = permissions('shop_manager')
  const view = permissions('accountant', 'shop_manager')

  router.get('/billable-jobs', finance, validate({ query: search }), async (req, res) => {
    const { q, page: current } = req.input.query
    const rows = await db.query(`SELECT j.id,v.registration_number,c.full_name AS customer_name,j.description
      FROM garage.jobs j JOIN garage.vehicles v ON v.id=j.vehicle_id JOIN garage.customers c ON c.id=j.customer_id
      WHERE j.status='completed' AND NOT EXISTS (SELECT 1 FROM garage.invoices i WHERE i.job_id=j.id)
      AND (v.registration_number ILIKE $1 OR c.full_name ILIKE $1 OR j.id::text=$2)
      ORDER BY j.completed_at DESC,j.id DESC LIMIT $3 OFFSET $4`, ['%' + q + '%', q, ...paging(current)])
    res.json(page(rows, current))
  })

  router.get('/invoices', view, validate({ query: search.extend({ kind: invoiceFilter.optional() }) }), async (req, res) => {
    const { q, page: current, kind } = req.input.query
    const rows = await db.query(invoiceSelect + `
      WHERE ($2::garage.invoice_kind IS NULL OR i.kind=$2) AND ($3::garage.invoice_kind IS NULL OR i.kind=$3)
      AND (coalesce(i.bill_to_name,c.full_name,'Walk-in customer') ILIKE $1 OR b.invoice_number ILIKE $1 OR i.id::text=$4)
      ORDER BY i.id DESC LIMIT $5 OFFSET $6`, ['%' + q + '%', shopScope(req.user), kind ?? null, q, ...paging(current)])
    res.json(page(rows, current))
  })

  router.post('/invoices/service', finance, validate({ body: serviceDraft }), async (req, res) => {
    const invoice = await db.transaction(async manager => {
      const job = found(await one(manager, `SELECT id,customer_id FROM garage.jobs WHERE id=$1 AND status='completed'`,
        [req.input.body.job_id]), 'Completed job')
      const invoice = await one(manager, `INSERT INTO garage.invoices (kind,job_id,customer_id,created_by)
        VALUES ('service',$1,$2,$3) RETURNING id`, [job.id, job.customer_id, req.user.id])
      await manager.query(`INSERT INTO garage.invoice_lines (invoice_id,labor_id,description,quantity,base_unit_price)
        SELECT $1,id,description,1,amount FROM garage.job_labor WHERE job_id=$2 ORDER BY id`, [invoice.id, job.id])
      await manager.query(`INSERT INTO garage.invoice_lines (invoice_id,part_id,part_request_id,description,quantity,base_unit_price)
        SELECT $1,r.part_id,r.id,p.name,r.quantity,r.fulfilled_unit_price FROM garage.part_requests r
        JOIN garage.parts p ON p.id=r.part_id WHERE r.job_id=$2 AND r.status='fulfilled' ORDER BY r.id`, [invoice.id, job.id])
      const lines = await one(manager, 'SELECT EXISTS(SELECT 1 FROM garage.invoice_lines WHERE invoice_id=$1) AS available', [invoice.id])
      if (!lines.available) throw new HttpError(409, 'This completed job has no labor or fulfilled parts to invoice.')
      return invoice
    })
    res.status(201).json(invoice)
  })

  router.post('/invoices/shop', shop, validate({ body: saleDraft }), async (req, res) => {
    const { lines, bill_to_name, bill_to_contact } = req.input.body
    const stockLines = new Set(lines.map(line => line.part_id))
    if (stockLines.size !== lines.length) throw new HttpError(400, 'Combine duplicate parts on a single line.')
    const invoice = await db.transaction(async manager => {
      const invoice = await one(manager, `INSERT INTO garage.invoices (kind,bill_to_name,bill_to_contact,created_by)
        VALUES ('shop_sale',$1,$2,$3) RETURNING id`, [bill_to_name ?? null, bill_to_contact ?? null, req.user.id])
      const inserted = await manager.query(`INSERT INTO garage.invoice_lines (invoice_id,part_id,description,quantity)
        SELECT $1,p.id,p.name,l.quantity FROM unnest($2::bigint[],$3::integer[]) l(part_id,quantity)
        JOIN garage.parts p ON p.id=l.part_id AND p.is_active ORDER BY p.id RETURNING id`,
      [invoice.id, lines.map(line => line.part_id), lines.map(line => line.quantity)])
      if (inserted.length !== lines.length) throw new HttpError(409, 'One or more parts are unavailable.')
      return invoice
    })
    res.status(201).json(invoice)
  })

  router.get('/invoices/:id', view, validate({ params: routeId }), async (req, res) => {
    const { id } = req.input.params
    const invoice = await accessibleInvoice(db, req.user, id)
    const lines = await db.query(`SELECT id,description,quantity,base_unit_price,override_unit_price,override_reason,line_total
      FROM garage.invoice_lines WHERE invoice_id=$1 ORDER BY id`, [id])
    const payments = req.user.role_code === 'shop_manager' ? [] : await db.query(`SELECT p.id,p.amount,p.method,p.status,p.external_reference,
      p.recorded_at,p.reviewed_at,r.receipt_number FROM garage.payments p LEFT JOIN garage.receipts r ON r.payment_id=p.id
      WHERE p.invoice_id=$1 ORDER BY p.id DESC`, [id])
    res.json({ ...invoice, lines, payments })
  })

  router.patch('/invoices/:id/lines/:lineId/price', permissions(),
    validate({ params: dto({ id, lineId: id }), body: overrideFields }), async (req, res) => {
      const { id, lineId } = req.input.params
      const { unit_price, reason } = req.input.body
      res.json(found(await one(db, `UPDATE garage.invoice_lines SET override_unit_price=$3,overridden_by=$4,override_reason=$5
        WHERE id=$1 AND invoice_id=$2 RETURNING id,line_total`, [lineId, id, unit_price, unit_price === null ? null : req.user.id, reason ?? null]),
      'Invoice line'))
    })

  router.post('/invoices/:id/issue', view, validate({ params: routeId }), async (req, res) => {
    const { id } = req.input.params
    const invoice = await db.transaction(async manager => {
      const current = await accessibleInvoice(manager, req.user, id, true)
      if (current.issued_at) return current
      if (current.kind === 'shop_sale' && req.user.role_code === 'accountant') throw new HttpError(403, 'The shop must issue this sale.')
      return one(manager, 'UPDATE garage.invoices SET issued_by=$2 WHERE id=$1 RETURNING id,kind,issued_at', [id, req.user.id])
    })
    res.json(invoice)
  })

  router.delete('/invoices/:id', view, validate({ params: routeId }), async (req, res) => {
    const { id } = req.input.params
    await db.transaction(async manager => {
      const invoice = await accessibleInvoice(manager, req.user, id, true)
      if (invoice.issued_at) throw new HttpError(409, 'Only drafts can be deleted.')
      if (invoice.kind === 'shop_sale' && req.user.role_code === 'accountant') throw new HttpError(403, 'The shop manages this sale.')
      await manager.query('DELETE FROM garage.invoice_lines WHERE invoice_id=$1', [id])
      await manager.query('DELETE FROM garage.invoices WHERE id=$1', [id])
    })
    res.status(204).end()
  })

  router.post('/invoices/:id/payments', finance, validate({ params: routeId, body: paymentFields }), async (req, res) => {
    const { id } = req.input.params
    const { amount, method, external_reference, idempotency_key, confirm } = req.input.body
    const result = await db.transaction(async manager => {
      const invoice = await accessibleInvoice(manager, req.user, id, true)
      if (!invoice.issued_at) throw new HttpError(409, 'Issue the invoice before recording payment.')
      const status = confirm ? 'confirmed' : 'pending'
      const payment = await one(manager, `INSERT INTO garage.payments
        (invoice_id,amount,method,external_reference,idempotency_key,status,recorded_by,reviewed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id,status`,
      [id, amount, method, external_reference ?? null, idempotency_key, status, req.user.id, confirm ? req.user.id : null])
      if (payment) return { payment, created: true }
      const existing = await one(manager, `SELECT id,status FROM garage.payments
        WHERE idempotency_key=$1 AND invoice_id=$2 AND amount=$3 AND method=$4
        AND external_reference IS NOT DISTINCT FROM $5`, [idempotency_key, id, amount, method, external_reference ?? null])
      if (!existing) throw new HttpError(409, 'This payment key belongs to a different payment.')
      return { payment: existing, created: false }
    })
    res.status(result.created ? 201 : 200).json(result.payment)
  })

  router.patch('/payments/:id', finance, validate({ params: routeId, body: dto({ status: z.enum(['confirmed', 'failed']) }) }), async (req, res) => {
    const { id } = req.input.params
    const { status } = req.input.body
    const payment = await db.transaction(async manager => {
      const current = found(await one(manager, 'SELECT id,invoice_id,status FROM garage.payments WHERE id=$1', [id]), 'Payment')
      await accessibleInvoice(manager, req.user, current.invoice_id, true)
      const result = await one(manager, `UPDATE garage.payments SET status=$2,reviewed_by=$3 WHERE id=$1 AND status='pending'
        RETURNING id,status`, [id, status, req.user.id])
      if (result) return result
      const latest = await one(manager, 'SELECT id,status FROM garage.payments WHERE id=$1', [id])
      if (latest.status === status) return latest
      throw new HttpError(409, 'This payment has already been reviewed.')
    })
    res.json(payment)
  })

  router.get('/receipts/:id', finance, validate({ params: routeId }), async (req, res) => {
    res.json(found(await one(db, 'SELECT * FROM garage.receipts WHERE payment_id=$1', [req.input.params.id]), 'Receipt'))
  })

  router.get('/reports/finance', finance, validate({ query: windowQuery }), async (req, res) => {
    res.json(await financeReport(db, req.input.query.months))
  })
}

export async function financeReport(db, months) {
  const [summary, revenue] = await Promise.all([
    one(db, `SELECT s.currency,
      coalesce(sum(b.paid_amount),0) AS cash_received, coalesce(sum(b.balance_due),0) AS outstanding,
      count(b.invoice_id) AS issued_invoices, count(b.invoice_id) FILTER (WHERE b.payment_status='paid') AS paid_invoices
      FROM garage.business_settings s LEFT JOIN garage.invoice_balances b ON b.currency=s.currency GROUP BY s.currency`),
    db.query(`WITH config AS (
      SELECT date_trunc('month', now() AT TIME ZONE reporting_timezone)::date AS current_month
      FROM garage.business_settings
    )
    SELECT to_char(m.month,'YYYY-MM') AS month, coalesce(r.revenue,0) AS revenue
    FROM config c CROSS JOIN LATERAL generate_series(c.current_month - ($1::int - 1) * interval '1 month',
      c.current_month, interval '1 month') m(month)
    LEFT JOIN garage.monthly_revenue r ON r.month=m.month::date ORDER BY m.month`, [months]),
  ])
  return { ...summary, revenue }
}
