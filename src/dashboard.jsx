import { useEffect, useId, useRef, useState } from 'react'
import { Activity, AlertTriangle, CalendarDays, CheckCircle2, CircleDollarSign, ClipboardList, Package, Plus, TrendingUp, Wallet, Wrench } from 'lucide-react'
import { date, money, number, useResource, withQuery } from './api.js'
import { Button, DataTable, Empty, Field, PageHeading, Panel, Record, Resource, Status } from './ui.jsx'

const monthName = value => new Intl.DateTimeFormat('en-KE', { month: 'short', timeZone: 'UTC' }).format(new Date(value + '-01T00:00:00Z'))
const compact = value => new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

export function Metric({ title, value, icon: Icon, tone, detail, detailTone }) {
  return <section className="metric"><div className="metric-top"><span>{title}</span><span className={`metric-icon tone-${tone}`}><Icon size={18} /></span></div>
    <strong>{value}</strong><span className={`metric-detail ${detailTone || ''}`}>{detail}</span>
  </section>
}

export function RevenueChart({ revenue, currency }) {
  const [active, setActive] = useState(null)
  const gradient = useId()
  const container = useRef(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(250, Math.min(720, Math.round(entry.contentRect.width))))
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const narrow = width < 475
  const baseline = narrow ? 144 : 193
  const left = narrow ? 43 : 63
  const right = narrow ? 17 : 32
  const bottom = baseline + 41
  const upper = 18
  const values = revenue.map(item => Number(item.revenue))
  const max = Math.max(...values, 0)
  const magnitude = 10 ** Math.floor(Math.log10(max || 100))
  const topValue = Math.ceil((max || 100) / magnitude) * magnitude
  const points = values.map((value, index) => ({
    x: left + index * (width - left - right) / Math.max(values.length - 1, 1),
    y: baseline - value / topValue * (baseline - upper),
  }))
  const line = points.map(({ x, y }, index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ')
  const area = points.length ? `${line} L${points.at(-1).x} ${baseline} L${points[0].x} ${baseline} Z` : ''
  return <div className="chart-root" ref={container}>
    <svg viewBox={`0 0 ${width} ${bottom}`} className="revenue-svg" role="img" aria-label={`Monthly confirmed revenue in ${currency}`}>
      <defs><linearGradient id={gradient} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#c8ed71" stopOpacity=".72" /><stop offset="100%" stopColor="#eaf6ce" stopOpacity=".13" />
      </linearGradient></defs>
      {[0, 1, 2, 3, 4].map(tick => {
        const y = upper + tick * (baseline - upper) / 4
        return <g key={tick}><line className="grid-line" x1={left - 10} y1={y} x2={width - 5} y2={y} />
          <text className="axis-label" x="0" y={y + 4}>{compact(topValue * (4 - tick) / 4)}</text></g>
      })}
      <path d={area} fill={`url(#${gradient})`} />
      <path d={line} fill="none" stroke="#77a92c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {points.map(({ x, y }, index) => <g key={revenue[index].month}>
        {(!narrow || points.length < 8 || index === points.length - 1 || (index % 2 === 0 && index < points.length - 2)) &&
          <text className="axis-label" x={x} y={baseline + 26} textAnchor="middle">{monthName(revenue[index].month)}</text>}
        <circle cx={x} cy={y} r={index === active ? 6 : 4} fill={index === active ? '#91c844' : '#fff'} stroke="#77a92c" strokeWidth="2" />
        <circle cx={x} cy={y} r="13" fill="transparent" onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}
          tabIndex="0" onFocus={() => setActive(index)} onBlur={() => setActive(null)}
          aria-label={`${monthName(revenue[index].month)} ${money(values[index], currency)}`}>
          <title>{money(values[index], currency)}</title>
        </circle>
      </g>)}
    </svg>
    {active !== null && revenue[active] && <div className="chart-tip">{monthName(revenue[active].month)} · {money(values[active], currency)}</div>}
  </div>
}

function Ranking({ items, title, caption, labelFor, valueFor, detailFor, unit, empty }) {
  const max = Math.max(1, ...items.map(valueFor))
  return <Panel title={title} caption={caption}>{!items.length ? <Empty title={empty} /> : <ul className="ranking">
    {items.map(item => <li key={item.part_id ?? item.mechanic_id}>
      <div className="rank-row"><Record title={labelFor(item)} subtitle={detailFor?.(item)} /><strong>{number(valueFor(item))} {unit === 'jobs' && valueFor(item) === 1 ? 'job' : unit}</strong></div>
      <progress max={max} value={valueFor(item)} aria-label={labelFor(item)} />
    </li>)}</ul>}</Panel>
}

export function Dashboard({ settings, navigate, openJob, revision }) {
  const [months, setMonths] = useState('6')
  const resource = useResource(withQuery('/analytics', { months }))
  useEffect(() => { if (revision) resource.refresh() }, [revision, resource.refresh])
  const currency = settings.currency
  return <>
    <PageHeading title="Garage overview" caption="Track workshop activity, inventory, and payments.">
      <div className="period-control"><CalendarDays size={17} /><Field label="Reporting window" value={months}
        onChange={event => setMonths(event.target.value)} options={[{ value: '6', label: 'Last 6 months' }, { value: '12', label: 'Last 12 months' }]} /></div>
      <Button icon={Plus} onClick={() => navigate('jobs', 'new')}>New job card</Button>
    </PageHeading>
    <Resource state={resource}>{({ finance, jobs, stock, alerts, parts, mechanics, recent }) => {
      const current = finance.revenue.at(-1)?.revenue
      const previous = Number(finance.revenue.at(-2)?.revenue)
      const trend = previous > 0 ? Math.round((Number(current) - previous) / previous * 100) : null
      return <>
        <div className="metric-grid">
          <Metric title="Revenue this month" value={money(current, currency, 0)} icon={CircleDollarSign} tone="lime"
            detail={trend === null ? 'Confirmed payments' : <><TrendingUp size={14} /> {trend > 0 ? '+' : ''}{trend}% vs. last month</>}
            detailTone={trend > 0 ? 'text-positive' : ''} />
          <Metric title="Active job cards" value={number(Number(jobs.pending) + Number(jobs.in_progress))} icon={Wrench} tone="blue"
            detail={`${number(jobs.in_progress)} in progress · ${number(jobs.pending)} pending`} />
          <Metric title="Completed jobs" value={number(jobs.completed)} icon={CheckCircle2} tone="violet"
            detail="Across all mechanics" />
          <Metric title="Low-stock parts" value={number(stock.low)} icon={Package} tone="amber"
            detail={`${number(stock.out_of_stock)} out of stock`} detailTone={Number(stock.out_of_stock) ? 'text-negative' : ''} />
        </div>
        <div className="dashboard-split">
          <Panel title="Revenue trend" caption="Confirmed payments by month" action={<span className="unit-tag">{currency}</span>} className="revenue-panel">
            <RevenueChart revenue={finance.revenue} currency={currency} />
          </Panel>
          <Panel title="Stock alerts" caption="Parts at or below reorder level" action={<span className="side-alert"><AlertTriangle size={18} /></span>}>
            {alerts.length ? <ul className="alert-list">{alerts.slice(0, 4).map(item => <li key={item.part_id}>
              <i><Package size={16} /></i><Record title={item.name} subtitle={item.sku} />
              <Status value={item.out_of_stock ? 'out' : 'low'}>{item.out_of_stock ? 'Out of stock' : `${item.stock_quantity} left`}</Status>
            </li>)}</ul> : <Empty title="Stock levels are healthy" detail="Low-stock parts will appear here." />}
            <div className="panel-footer"><button className="text-button" onClick={() => navigate('inventory', 'low')}>View low-stock inventory</button></div>
          </Panel>
        </div>
        <Panel title="Recent job cards" caption="Latest workshop activity" action={<Button variant="secondary" icon={ClipboardList} onClick={() => navigate('jobs')}>View jobs</Button>}>
          <DataTable rows={recent} empty="Create a job card to start tracking workshop activity." columns={[
            { key: 'id', title: 'Job card', render: row => <button className="text-button" onClick={() => openJob(row.id)}>JOB-{row.id}</button> },
            { key: 'registration_number', title: 'Vehicle', render: row => <Record title={`${row.make} ${row.model}`} subtitle={row.registration_number} /> },
            { key: 'customer_name', title: 'Customer', compactHide: true },
            { key: 'mechanic_name', title: 'Mechanic', compactHide: true },
            { key: 'opened_at', title: 'Opened', compactHide: true, render: row => date(row.opened_at, settings.reporting_timezone) },
            { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
          ]} />
        </Panel>
        <div className="rank-grid">
          <Ranking title="Top-selling parts" caption="Units on issued invoices" items={parts}
            labelFor={part => part.name} valueFor={part => Number(part.units_sold)} detailFor={part => part.sku} unit="sold" empty="No parts sales yet" />
          <Ranking title="Mechanic performance" caption="Completed jobs by mechanic" items={mechanics}
            labelFor={person => person.full_name} valueFor={person => Number(person.completed_jobs)} unit="jobs" empty="No mechanics assigned yet" />
        </div>
      </>
    }}</Resource>
  </>
}

export function Finance({ settings }) {
  const [months, setMonths] = useState('6')
  const resource = useResource(withQuery('/reports/finance', { months }))
  return <>
    <PageHeading title="Financial reports" caption="Review collections, open balances, and monthly revenue.">
      <Field label="Reporting window" value={months} onChange={event => setMonths(event.target.value)}
        options={[{ value: '6', label: 'Last 6 months' }, { value: '12', label: 'Last 12 months' }]} />
    </PageHeading>
    <Resource state={resource}>{data => <>
      <div className="metric-grid">
        <Metric title="Total collected" value={money(data.cash_received, settings.currency)} icon={Wallet} tone="lime" detail="Confirmed payments" />
        <Metric title="Outstanding" value={money(data.outstanding, settings.currency)} icon={Activity} tone="amber" detail="Open invoice balances" />
        <Metric title="Issued invoices" value={number(data.issued_invoices)} icon={ClipboardList} tone="blue" detail="Service and counter sales" />
        <Metric title="Paid invoices" value={number(data.paid_invoices)} icon={CheckCircle2} tone="violet" detail="Fully settled invoices" />
      </div>
      <Panel title="Revenue trend" caption="Confirmed payments by month" action={<span className="unit-tag">{settings.currency}</span>}>
        <RevenueChart revenue={data.revenue} currency={settings.currency} />
        <DataTable rows={data.revenue.map(row => ({ ...row, id: row.month }))} columns={[
          { key: 'month', title: 'Reporting month', render: row => `${monthName(row.month)} ${row.month.slice(0, 4)}` },
          { key: 'revenue', title: 'Confirmed revenue', render: row => money(row.revenue, settings.currency) },
        ]} />
      </Panel>
    </>}</Resource>
  </>
}
