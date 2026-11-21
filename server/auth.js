import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { rateLimit } from 'express-rate-limit'
import { dto, email, HttpError, loginPassword, validate } from './validation.js'
import { one } from './db.js'

const cookieName = 'garage_session'
const duration = 8 * 60 * 60 * 1000
const algorithmCost = 12
const dummyHash = await bcrypt.hash(randomBytes(24).toString('hex'), algorithmCost)
const hashToken = token => createHash('sha256').update(token).digest()

export const hashPassword = password => bcrypt.hash(password, algorithmCost)

function sessionToken(req) {
  const token = req.headers.cookie?.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null
}

export function permissions(...allowed) {
  return (req, res, next) => {
    if (req.user.role_code === 'admin' || allowed.includes(req.user.role_code)) return next()
    next(new HttpError(403, 'Your role cannot access this operation.'))
  }
}

export function mountAuthentication(router, db, secure) {
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' }
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  })

  router.post('/auth/login', limiter, validate({ body: dto({ email, password: loginPassword }) }), async (req, res) => {
    const { email, password } = req.input.body
    const user = await one(db, `SELECT id, full_name, email, role_code, is_active, password_hash
      FROM garage.users WHERE lower(email) = $1`, [email])
    const matches = await bcrypt.compare(password, user?.password_hash ?? dummyHash)
    if (!matches || !user?.is_active) throw new HttpError(401, 'The email or password is incorrect.')

    const token = randomBytes(32).toString('hex')
    const profile = await db.transaction(async manager => {
      const verified = await one(manager, `SELECT id, full_name, email, role_code
        FROM garage.users WHERE id=$1 AND password_hash=$2 AND is_active FOR SHARE`, [user.id, user.password_hash])
      if (!verified) throw new HttpError(401, 'The email or password is incorrect.')
      await manager.query('DELETE FROM garage.user_sessions WHERE expires_at <= now() OR token_hash = $1', [
        sessionToken(req) ? hashToken(sessionToken(req)) : null,
      ])
      await manager.query(`INSERT INTO garage.user_sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, now() + interval '8 hours')`, [hashToken(token), user.id])
      return verified
    })
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: duration }).json(profile)
  })

  router.use(async (req, res, next) => {
    const token = sessionToken(req)
    if (token) {
      req.sessionHash = hashToken(token)
      req.user = await one(db, `SELECT u.id, u.full_name, u.email, u.role_code
        FROM garage.user_sessions s JOIN garage.users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`, [req.sessionHash])
    }
    if (!req.user) throw new HttpError(401, 'Sign in to continue.')
    next()
  })

  router.get('/auth/me', validate(), (req, res) => res.json(req.user))
  router.post('/auth/logout', validate(), async (req, res) => {
    await db.query('DELETE FROM garage.user_sessions WHERE token_hash = $1', [req.sessionHash])
    res.clearCookie(cookieName, cookieOptions).status(204).end()
  })
}
