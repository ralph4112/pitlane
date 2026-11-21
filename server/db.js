import 'reflect-metadata'
import { DataSource, EntitySchema } from 'typeorm'

const User = new EntitySchema({
  name: 'User',
  schema: 'garage',
  tableName: 'users',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'identity' },
    role_code: { type: 'text' },
    full_name: { type: 'text' },
    email: { type: 'text' },
    password_hash: { type: 'text', select: false },
    is_active: { type: 'boolean' },
    created_at: { type: 'timestamptz', createDate: true },
  },
})

export function dataSource(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('Set DATABASE_URL to a PostgreSQL connection URL.')
  return new DataSource({
    type: 'postgres', url, entities: [User], synchronize: false,
    connectTimeoutMS: 5000,
  })
}

export async function one(db, sql, parameters = []) {
  const result = await db.query(sql, parameters)
  // TypeORM's PostgreSQL driver wraps UPDATE/DELETE rows and affected count.
  const rows = Array.isArray(result[0]) ? result[0] : result
  return rows[0]
}
