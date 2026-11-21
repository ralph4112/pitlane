import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Bell, Boxes, CarFront, ChartNoAxesCombined, ChevronRight, ClipboardList,
  Gauge, LogOut, Menu, MessageSquare, PackageCheck, ReceiptText, ShieldCheck, ShoppingCart, UsersRound, Wrench, X,
} from 'lucide-react'
import { api, roleNames, useResource } from './api.js'
import { Feedback, Users } from './admin.jsx'
import { Dashboard, Finance } from './dashboard.jsx'
import { InvoiceDetail, Invoices } from './billing.jsx'
import { Customers, JobDetail, Jobs } from './jobs.jsx'
import { Inventory, Requests } from './shop.jsx'
import { ActionForm, ErrorNotice, Field, Loading, Resource } from './ui.jsx'
import './styles.css'

const navigation = [
  { heading: 'WORKSPACE', links: [
    ['overview', 'Overview', Gauge, ['admin']],
    ['jobs', 'Job cards', ClipboardList, ['admin', 'mechanic']],
    ['customers', 'Customers & vehicles', CarFront, ['admin']],
  ] },
  { heading: 'PARTS SHOP', links: [
    ['inventory', 'Inventory', Boxes, ['admin', 'shop_manager']],
    ['requests', 'Parts requests', PackageCheck, ['admin', 'shop_manager']],
    ['sales', 'Counter sales', ShoppingCart, ['admin', 'shop_manager']],
  ] },
  { heading: 'MANAGEMENT', links: [
    ['invoices', 'Invoices & payments', ReceiptText, ['admin', 'accountant']],
    ['reports', 'Financial reports', ChartNoAxesCombined, ['admin', 'accountant']],
    ['feedback', 'Customer feedback', MessageSquare, ['admin']],
    ['team', 'Team & permissions', UsersRound, ['admin']],
  ] },
]

function Brand() {
  return <div className="brand"><span className="brand-icon"><Wrench size={22} strokeWidth={2.3} /></span>
    <span><strong>Pitlane</strong><small>GARAGE MANAGEMENT</small></span></div>
}

function Login({ onSignedIn }) {
  return <main className="login-screen">
    <section className="login-aside"><Brand />
      <div className="login-copy"><span className="login-mark"><Gauge size={53} strokeWidth={1.45} /></span>
        <h1>Workshop<br />operations</h1><p>Service jobs, spare parts, and payments in one workspace.</p></div>
      <div className="login-aside-foot"><ShieldCheck size={17} /> Staff access</div>
    </section>
    <section className="login-content"><div className="login-box">
      <div className="login-mobile-brand"><Brand /></div>
      <h2>Sign in</h2><p>Use your staff account to open the garage workspace.</p>
      <ActionForm submit="Sign in" onSubmit={async fields => {
        const profile = await api('/auth/login', { method: 'POST', data: { email: fields.get('email'), password: fields.get('password') } })
        onSignedIn(profile)
      }}>
        <Field label="Email address" type="email" name="email" autoComplete="username" required maxLength={254} placeholder="you@example.com" />
        <Field label="Password" type="password" name="password" autoComplete="current-password" required maxLength={72} placeholder="Enter your password" />
      </ActionForm>
    </div></section>
  </main>
}

function Workspace({ user, setUser }) {
  const allowed = navigation.flatMap(group => group.links.filter(link => link[3].includes(user.role_code)))
  const fallback = allowed[0][0]
  const [route, setRoute] = useState(() => ({ key: location.hash.slice(1) || fallback, action: '', revision: 0 }))
  const [detail, setDetail] = useState(null)
  const [revision, setRevision] = useState(0)
  const [navOpen, setNavOpen] = useState(false)
  const [signoutError, setSignoutError] = useState(null)
  const settings = useResource('/settings')
  const key = allowed.some(link => link[0] === route.key) ? route.key : fallback
  const current = allowed.find(link => link[0] === key)
  const canSeeStock = user.role_code === 'admin' || user.role_code === 'shop_manager'

  const navigate = (key, action = '') => {
    if (location.hash !== '#' + key) history.pushState({}, '', '#' + key)
    setRoute(previous => ({ key, action, revision: action || previous.key !== key ? previous.revision + 1 : previous.revision }))
    setNavOpen(false)
    setDetail(null)
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const restore = () => {
      setRoute(previous => ({ key: location.hash.slice(1) || fallback, action: '', revision: previous.revision + 1 }))
      setDetail(null)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => {
      window.removeEventListener('popstate', restore)
      window.removeEventListener('hashchange', restore)
    }
  }, [fallback])

  const changed = () => setRevision(value => value + 1)
  const open = (kind, id, refresh) => {
    if (refresh) changed()
    setDetail({ kind, id })
  }
  const closeDetail = () => setDetail(null)
  const clearAction = () => setRoute(previous => ({ ...previous, action: '' }))
  const initials = user.full_name.split(/\s+/).slice(0, 2).map(name => name[0]).join('').toUpperCase()
  return <>
    <div className="workspace">
      {navOpen && <button type="button" className="nav-overlay" onClick={() => setNavOpen(false)} aria-label="Close navigation" />}
      <aside className={`sidebar ${navOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head"><Brand /><button type="button" className="menu-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}><X size={23} /></button></div>
        <nav className="navigation" aria-label="Garage modules">
          {navigation.map(group => {
            const links = group.links.filter(link => link[3].includes(user.role_code))
            return links.length ? <section className="nav-group" key={group.heading}>
              <h2>{group.heading}</h2>
              {links.map(([value, label, Icon]) => <a href={'#' + value} key={value} className={value === key ? 'nav-active' : ''}
                aria-current={value === key ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(value) }}>
                <Icon size={18} strokeWidth={1.9} /><span>{label}</span>{value === key && <span className="nav-marker" />}
              </a>)}
            </section> : null
          })}
        </nav>
        <div className="sidebar-profile">
          <span className="avatar">{initials}</span><span className="profile-text"><strong>{user.full_name}</strong><small>{roleNames[user.role_code]}</small></span>
          <button className="logout-button" type="button" aria-label="Sign out" title="Sign out" onClick={async () => {
            try {
              await api('/auth/logout', { method: 'POST' })
              setUser(null)
            } catch (error) {
              setSignoutError(error)
            }
          }}><LogOut size={18} /></button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="crumb"><button className="icon-button menu-button" type="button" aria-expanded={navOpen}
            aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu size={21} /></button>
            <span>Workspace</span><ChevronRight size={15} /><strong>{current[1]}</strong></div>
          <div className="topbar-actions">
            {canSeeStock && <button className="icon-button alert-button" type="button" aria-label="Stock alerts" title="Stock alerts"
              onClick={() => navigate('inventory', 'low')}><Bell size={19} /></button>}
            <span className="topbar-separator" />
            <span className="topbar-avatar avatar" title={user.full_name}>{initials}</span>
          </div>
        </header>
        <main className="content">
          <ErrorNotice error={signoutError} />
          <Resource state={settings}>{values => {
            const components = {
              overview: Dashboard, jobs: Jobs, customers: Customers, inventory: Inventory, requests: Requests, sales: Invoices,
              invoices: Invoices, reports: Finance, feedback: Feedback, team: Users,
            }
            const View = components[key]
            return <View key={key + route.revision} user={user} settings={values} initialAction={route.action} clearAction={clearAction}
              openJob={(id, refresh) => open('job', id, refresh)} openInvoice={(id, refresh) => open('invoice', id, refresh)}
              onProfileChanged={setUser} navigate={navigate} revision={revision} selling={key === 'sales'} />
          }}</Resource>
        </main>
      </div>
    </div>
    {detail && settings.data && (detail.kind === 'job'
      ? <JobDetail key={detail.id} id={detail.id} user={user} settings={settings.data}
        onClose={closeDetail} onChanged={changed} onInvoice={(job, invoice) => invoice ? open('invoice', invoice) : navigate('invoices', 'job-' + job)} />
      : <InvoiceDetail key={detail.id} id={detail.id} user={user} settings={settings.data} onClose={closeDetail} onChanged={changed} />)}
  </>
}

function App() {
  const [user, setUser] = useState(undefined)
  const [error, setError] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    const logout = () => setUser(null)
    window.addEventListener('session-ended', logout)
    api('/auth/me', { signal: controller.signal }).then(setUser, error => {
      if (error.name === 'AbortError') return
      if (error.status !== 401) setError(error)
      setUser(null)
    })
    return () => {
      controller.abort()
      window.removeEventListener('session-ended', logout)
    }
  }, [])
  if (user === undefined) return <div className="startup"><Loading /></div>
  if (error) return <div className="startup"><ErrorNotice error={error} /><button className="text-button" onClick={() => location.reload()}>Retry</button></div>
  return user ? <Workspace key={user.id} user={user} setUser={setUser} /> : <Login onSignedIn={setUser} />
}

createRoot(document.getElementById('root')).render(<App />)
