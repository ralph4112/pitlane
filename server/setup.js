import { readFile } from 'node:fs/promises'
import { dataSource, one } from './db.js'
import { hashPassword } from './auth.js'
import { currency, email, password, text } from './validation.js'

const db = await dataSource().initialize()
try {
  const adminEmail = email.parse(process.env.ADMIN_EMAIL)
  const adminPassword = password.parse(process.env.ADMIN_PASSWORD)
  const adminName = text().parse(process.env.ADMIN_NAME || 'Garage Administrator')
  const unit = currency.parse(process.env.GARAGE_CURRENCY || 'KES')
  const timeZone = text().parse(process.env.GARAGE_TIMEZONE || 'Africa/Nairobi')
  const existing = await one(db, "SELECT to_regclass('garage.users') IS NOT NULL AS installed")
  if (!existing.installed) {
    await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  }
  await db.query(await readFile(new URL('../db/sessions.sql', import.meta.url), 'utf8'))
  await db.transaction(async manager => {
    await manager.query(`INSERT INTO garage.business_settings (currency, reporting_timezone)
      VALUES ($1, $2) ON CONFLICT (singleton) DO NOTHING`, [unit, timeZone])
    await manager.query(`INSERT INTO garage.users (role_code, full_name, email, password_hash)
      VALUES ('admin', $1, $2, $3) ON CONFLICT DO NOTHING`, [adminName, adminEmail, await hashPassword(adminPassword)])
    const admin = await one(manager, `SELECT id FROM garage.users
      WHERE lower(email) = $1 AND role_code = 'admin' AND is_active`, [adminEmail])
    if (!admin) throw new Error('ADMIN_EMAIL belongs to an inactive user or a user with a different role.')
  })
  console.log('Garage database and administrator are ready.')
} finally {
  await db.destroy()
}
