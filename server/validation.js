import { z } from 'zod'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const dto = (fields = {}) => z.strictObject(fields)
export const id = z.string().regex(/^[1-9]\d{0,18}$/).pipe(z.string().refine(value => BigInt(value) <= 9223372036854775807n))
export const routeId = dto({ id })
export const text = (max = 200) => z.string().trim().min(1).max(max)
export const email = z.string().trim().max(254).pipe(z.email()).transform(value => value.toLowerCase())
export const password = z.string().min(12).max(72).refine(value => Buffer.byteLength(value) <= 72, 'Use at most 72 UTF-8 bytes.')
export const loginPassword = z.string().min(1).max(72).refine(value => Buffer.byteLength(value) <= 72)
export const currency = z.string().regex(/^[A-Z]{3}$/)
export const money = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/, 'Enter an amount with up to two decimal places.')
export const positiveMoney = money.refine(value => Number(value) > 0, 'Enter a positive amount.')
export const quantity = z.int().min(1).max(1000000)
export const count = z.int().min(0).max(1000000)
export const roles = z.enum(['admin', 'mechanic', 'shop_manager', 'accountant'])
export const jobStatus = z.enum(['pending', 'in_progress', 'completed'])
export const paymentMethod = z.enum(['cash', 'card', 'bank_transfer', 'mobile_money'])
export const invoiceFilter = z.enum(['service', 'shop_sale'])
export const search = dto({
  q: z.string().trim().max(100).optional().default(''),
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional().default(1),
})
export const windowQuery = dto({ months: z.enum(['6', '12']).transform(Number).optional().default(6) })

export function validate({ params = dto(), query = dto(), body = dto() } = {}) {
  return (req, res, next) => {
    try {
      req.input = { params: params.parse(req.params), query: query.parse(req.query), body: body.parse(req.body ?? {}) }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function found(row, label) {
  if (!row) throw new HttpError(404, `${label} was not found.`)
  return row
}
