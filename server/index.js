import express from 'express'
import helmet from 'helmet'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { dataSource, one } from './db.js'

const dev = process.argv.includes('--dev')
const secure = process.env.NODE_ENV === 'production'
const origin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || undefined
const port = Number(process.env.PORT || '5173')
const host = process.env.HOST || '127.0.0.1'
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0)
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 10) {
  throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10.')
}
if (secure && (!origin || new URL(origin).protocol !== 'https:' || origin !== new URL(origin).origin)) {
  throw new Error('Set APP_ORIGIN to the public HTTPS origin in production, or use the URL supplied by Render.')
}
const db = await dataSource().initialize()
const available = await one(db, "SELECT to_regclass('garage.user_sessions') IS NOT NULL AS installed")
if (!available.installed) {
  await db.destroy()
  throw new Error('Run npm run db:setup before starting the garage.')
}
const app = createApp(db, { origin, secure, trustProxy: proxyHops || false })
const server = createServer(app)
if (dev) {
  const { createServer: viteServer } = await import('vite')
  const vite = await viteServer({ server: { middlewareMode: true, hmr: { server } } })
  app.use(vite.middlewares)
} else {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  app.use(helmet({ crossOriginEmbedderPolicy: false }))
  app.use(express.static(dist))
  app.get(/.*/, (_req, res) => res.sendFile('index.html', { root: dist }))
}
server.listen(port, host, () => console.log(`Pitlane Garage is available at http://${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => {
    await db.destroy()
    process.exit(0)
  }))
}
