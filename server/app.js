import express from 'express'
import helmet from 'helmet'
import { ZodError } from 'zod'
import { mountAdmin } from './admin.js'
import { mountAuthentication } from './auth.js'
import { mountBilling } from './billing.js'
import { one } from './db.js'
import { mountJobs } from './jobs.js'
import { mountShop } from './shop.js'
import { HttpError, validate } from './validation.js'

export function createApp(db, { origin, secure = false, trustProxy = false } = {}) {
  const app = express()
  const api = express.Router()
  app.disable('x-powered-by')
  app.set('trust proxy', trustProxy)
  app.use('/api', helmet())
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    const trusted = origin ?? `http://${req.get('host')}`
    if ((req.get('origin') && req.get('origin') !== trusted) || req.get('sec-fetch-site') === 'cross-site') {
      return next(new HttpError(403, 'This request must come from the garage workspace.'))
    }
    const hasBody = Number(req.get('content-length')) > 0 || Boolean(req.get('transfer-encoding'))
    if (hasBody && !req.is('application/json')) {
      return next(new HttpError(415, 'Send the request as application/json.'))
    }
    next()
  })
  app.use('/api', express.json({ limit: '128kb', strict: true }))
  app.use('/api', api)
  api.get('/health', validate(), async (_req, res) => {
    try {
      await db.query('SELECT 1')
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'unavailable' })
    }
  })
  mountAuthentication(api, db, secure)
  api.get('/settings', validate(), async (_req, res) => {
    res.json(await one(db, 'SELECT currency,reporting_timezone FROM garage.business_settings WHERE singleton'))
  })
  mountJobs(api, db)
  mountShop(api, db)
  mountBilling(api, db)
  mountAdmin(api, db)
  api.use((_req, _res, next) => next(new HttpError(404, 'This operation does not exist.')))
  app.use('/api', (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'Check the information you entered.',
        issues: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })),
      })
    }
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request contains invalid JSON.' })
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' })
    if (error.code === 'P0001') return res.status(409).json({ error: error.message })
    if (error.code === '23505') return res.status(409).json({ error: 'A record with this identifier already exists.' })
    if (['23503', '23514', '23502', '22003'].includes(error.code)) {
      return res.status(409).json({ error: 'This change conflicts with the current records. Check the values and try again.' })
    }
    if (['40001', '40P01'].includes(error.code)) return res.status(409).json({ error: 'Another change was saved first. Refresh and try again.' })
    console.error('Garage API error', error.code ?? error.name)
    res.status(500).json({ error: 'The garage could not complete this operation.' })
  })
  return app
}
